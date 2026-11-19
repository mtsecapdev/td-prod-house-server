import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import config from '../config.js';
import AppError from '../utils/AppError.js';

const { baseUrl, dir: comfyDir } = config.comfyui;

let comfyProcess = null;

const NOT_SET_UP = 'Image generation is not set up on this server: ComfyUI is not running and could not be started.';

/** Makes sure ComfyUI answers, starting the portable install in COMFYUI_DIR if needed. */
export async function ensureRunning() {
  if (await isAvailable()) return;

  if (comfyProcess) {
    comfyProcess.kill('SIGTERM');
    comfyProcess = null;
  }

  const pythonPath = join(comfyDir, 'python_embeded', 'python.exe');
  const mainPath = join(comfyDir, 'ComfyUI', 'main.py');
  // Without an install there is nothing to start (and spawning a missing program would crash the server).
  if (!(await access(pythonPath).then(() => true, () => false))) throw new AppError(NOT_SET_UP, 503);

  comfyProcess = spawn(pythonPath, ['-s', mainPath, '--windows-standalone-build'], {
    cwd: comfyDir,
    stdio: 'ignore',
    detached: true,
  });

  comfyProcess.on('error', () => { comfyProcess = null; });
  comfyProcess.on('exit', () => { comfyProcess = null; });
  comfyProcess.unref();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isAvailable()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new AppError(NOT_SET_UP, 503);
}

function buildWorkflow(prompt, { width = 1024, height = 1024, steps = 4, seed } = {}) {
  const actualSeed = seed ?? Math.floor(Math.random() * 2 ** 32);

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'flux1-schnell.safetensors', weight_dtype: 'default' },
    },
    '2': {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp8_e4m3fn.safetensors', type: 'flux' },
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: 'ae.safetensors' },
    },
    '4': {
      class_type: 'CLIPTextEncodeFlux',
      inputs: { clip: ['2', 0], clip_l: prompt, t5xxl: prompt, guidance: 3.5 },
    },
    '5': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width, height, batch_size: 1 },
    },
    '6': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['4', 0],
        latent_image: ['5', 0],
        seed: actualSeed,
        steps,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
      },
    },
    '7': {
      class_type: 'VAEDecode',
      inputs: { samples: ['6', 0], vae: ['3', 0] },
    },
    '8': {
      class_type: 'SaveImage',
      inputs: { images: ['7', 0], filename_prefix: 'tdph' },
    },
  };
}

export async function queuePrompt(promptText, options = {}) {
  const workflow = buildWorkflow(promptText, options);

  const res = await fetch(new URL('/prompt', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AppError(`ComfyUI prompt failed: ${body}`, 502);
  }

  const data = await res.json();
  return data.prompt_id;
}

export async function pollUntilDone(promptId, { timeout = 300_000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const res = await fetch(new URL(`/history/${promptId}`, baseUrl));
    if (!res.ok) throw new AppError('ComfyUI history request failed', 502);

    const data = await res.json();
    const entry = data[promptId];

    if (entry) {
      if (entry.status?.status_str === 'error') {
        throw new AppError('ComfyUI generation failed', 502);
      }
      const outputs = entry.outputs;
      for (const nodeId of Object.keys(outputs)) {
        const images = outputs[nodeId]?.images;
        if (images?.length) {
          return images.map((img) => ({
            filename: img.filename,
            subfolder: img.subfolder || '',
            type: img.type || 'output',
          }));
        }
      }
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new AppError('ComfyUI generation timed out', 504);
}

export async function downloadImage(filename, subfolder = '', type = 'output') {
  const url = new URL('/view', baseUrl);
  url.searchParams.set('filename', filename);
  if (subfolder) url.searchParams.set('subfolder', subfolder);
  url.searchParams.set('type', type);

  const res = await fetch(url);
  if (!res.ok) throw new AppError(`ComfyUI image download failed: ${res.statusText}`, 502);

  return Buffer.from(await res.arrayBuffer());
}

export async function freeVram() {
  try {
    await fetch(new URL('/free', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
  } catch {}
}

export async function isAvailable() {
  try {
    const res = await fetch(new URL('/system_stats', baseUrl), { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
