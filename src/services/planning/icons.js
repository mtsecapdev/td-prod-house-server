// Picks each point's icon (lists whose spec says icons: true). The point's heading and detail are compared by
// meaning (the search model) with each icon's meaning in shared/slides/spec.js, and points take the best icons
// in turn, so no two points on a slide share one. Asked to choose from the list itself, the writer gave three
// points the same cog and a calendar to "Example".
import { requestEmbeddingBatch } from '../llm.js';
import { KINDS, ICONS, ICON_NAMES } from '../../../shared/slides/spec.js';

let iconVectors = null;

async function meaningVectors() {
  if (!iconVectors) iconVectors = requestEmbeddingBatch(ICON_NAMES.map((n) => `${n.replace(/-/g, ' ')}: ${ICONS[n]}`));
  try {
    return await iconVectors;
  } catch (err) {
    iconVectors = null;
    throw err;
  }
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
};

/** The icon lists of a kind: names of list fields with icons. */
function iconLists(kindName) {
  return Object.entries(KINDS[kindName]?.fields || {}).filter(([, f]) => f.type === 'list' && f.icons).map(([name]) => name);
}

/**
 * Returns content with an icon on every entry of its icon lists. Entries that already have a valid icon keep
 * it (the user's choice, or one kept from before an edit); `previous` content lends its icons to entries whose
 * heading is unchanged.
 */
export async function withIcons(kindName, content, previous = null) {
  const lists = iconLists(kindName);
  if (!lists.length || !content) return content;
  const out = { ...content };
  for (const name of lists) {
    const before = new Map((previous?.[name] || []).filter((e) => e?.icon).map((e) => [String(e.heading || '').trim(), e.icon]));
    const entries = (out[name] || []).map((e) => {
      const kept = ICONS[e.icon] ? e.icon : before.get(String(e.heading || '').trim());
      return kept ? { ...e, icon: kept } : { ...e, icon: '' };
    });
    const missing = entries.map((e, i) => (e.icon ? null : i)).filter((i) => i !== null);
    if (missing.length) {
      const [vectors, own] = await Promise.all([
        meaningVectors(),
        requestEmbeddingBatch(missing.map((i) => `${entries[i].heading || ''}. ${entries[i].detail || ''}`)),
      ]);
      const taken = new Set(entries.map((e) => e.icon).filter(Boolean));
      // Best pairs first, each icon used once on the slide.
      const pairs = [];
      missing.forEach((i, k) => ICON_NAMES.forEach((icon, j) => pairs.push({ i, icon, score: cosine(own[k], vectors[j]) })));
      pairs.sort((a, b) => b.score - a.score);
      for (const { i, icon } of pairs) {
        if (entries[i].icon || taken.has(icon)) continue;
        entries[i] = { ...entries[i], icon };
        taken.add(icon);
      }
    }
    out[name] = entries;
  }
  return out;
}
