// The slide design spec: the one place that says what kinds of slide exist, what each holds, how long each text
// may be and whether a picture can sit beside it. Everything else reads it: the planner (which kind fits),
// the writer (its JSON schema and instructions), the length check (fit.js), the layout engine (layout.js) that
// places every box, and through it the PowerPoint renderer and the editor's preview.
//
// Served unchanged to the browser (/api/shared/slides/spec.js), so it has no imports outside this folder.

// ── Field types ──

const text = (max, guide) => ({ type: 'text', max, guide });
const notes = () => ({ type: 'notes' });
/** A list: of text (item is a text field) or of entries (item maps names to text fields). */
const list = (item, { min, max, write, guide, icons = false }) => ({ type: 'list', item, min, max, write, guide, icons });
const table = ({ columns, rows, column, cell, guide }) => ({ type: 'table', columns, rows, column, cell, guide });
const choice = (options, guide) => ({ type: 'choice', options, guide });
const code = (guide) => ({ type: 'code', guide });

// ── Slide kinds ──
// use: what the planner reads to choose a kind. label, description: what the editor shows.
// picture: a picture from the documents can sit in a panel beside it (the layout engine rearranges the text).
// sourced: written from facts in the documents (title and closing frame the deck instead).
// position: 'first' / 'last' kinds are placed by the app, never chosen.

export const KINDS = {
  title: {
    label: 'Title', description: 'Opening slide', position: 'first', picture: false, sourced: false,
    use: 'The opening slide.',
    fields: {
      title: text(60, 'names the subject in a few words'),
      subtitle: text(150, 'one sentence: what the audience will be able to do afterwards'),
    },
  },
  section: {
    label: 'Section', description: 'Opens a new part', picture: false, sourced: false, minDeck: 10,
    use: 'Opens a new part of a long deck (10 or more slides only).',
    fields: {
      title: text(50, 'names the part in 2-5 words'),
      subtitle: text(140, 'one sentence on what the part covers'),
    },
  },
  points: {
    label: 'Points', description: 'A few points, facts or reasons', picture: true, sourced: true,
    use: 'A few points, facts or reasons that explain or teach (the usual kind).',
    fields: {
      title: text(60, 'the slide\'s point as a short statement'),
      points: list({
        heading: text(36, '2-5 words naming the point'),
        detail: text(110, 'one short sentence with the specific fact, reason or action'),
      }, { min: 1, max: 6, write: '2-4 points; up to 6 only when they are very short', icons: true }),
      speaker_notes: notes(),
    },
  },
  steps: {
    label: 'Steps', description: 'A sequence, procedure or timeline', picture: true, sourced: true,
    use: 'Steps in order: a procedure to carry out, a process where each stage feeds the next, or dated events.',
    fields: {
      title: text(60, 'the slide\'s point as a short statement'),
      steps: list({
        label: text(32, 'the step in 2-5 words, verb first for an action'),
        detail: text(110, 'one sentence: how, or what happens'),
        when: text(16, 'the date or phase when the steps are dated events, otherwise empty'),
      }, { min: 2, max: 7, write: '3-6 steps in order' }),
      speaker_notes: notes(),
    },
  },
  numbers: {
    label: 'Numbers', description: 'Key figures', picture: true, sourced: true,
    use: 'Figures that carry the point: one headline number, or a few results shown side by side. Only when the facts state the numbers.',
    fields: {
      title: text(60, 'the slide\'s point as a short statement'),
      numbers: list({
        value: text(14, 'the number with its unit, exactly as the facts give it'),
        label: text(36, 'what it measures, 2-5 words'),
        detail: text(110, 'one sentence the facts give about it'),
      }, { min: 1, max: 4, write: 'one headline figure, or 2-4 related ones' }),
      speaker_notes: notes(),
    },
  },
  statement: {
    label: 'Statement', description: 'One message, rule or quote', picture: true, sourced: true,
    use: 'One message, rule or principle to remember, or a verbatim quote from the documents. At most one or two per deck.',
    fields: {
      title: text(40, 'a short label for the slide, 1-4 words'),
      statement: text(120, 'the message as one complete sentence; a quote copied exactly when attributed'),
      supporting: text(180, 'one sentence of evidence or context'),
      attribution: text(60, 'who or what document said it, only when statement is a verbatim quote, otherwise empty'),
      speaker_notes: notes(),
    },
  },
  compare: {
    label: 'Compare', description: 'Two sides set against each other', picture: true, sourced: true,
    use: 'Two things set against each other: before/after, option A/B, do/don\'t.',
    fields: {
      title: text(60, 'the slide\'s point as a short statement'),
      sides: list({
        heading: text(40, 'names the side'),
        points: list(text(110, 'one short point'), { min: 1, max: 5, write: '2-4 points' }),
      }, { min: 2, max: 2, write: 'exactly two sides' }),
      verdict: text(140, 'one sentence of conclusion when the comparison leads to one, otherwise empty'),
      speaker_notes: notes(),
    },
  },
  table: {
    label: 'Table', description: 'Items compared on the same attributes', picture: true, sourced: true,
    use: 'Several items given the same attributes (specifications, types, options), when a grid shows a pattern.',
    fields: {
      title: text(60, 'the slide\'s point as a short statement'),
      grid: table({ columns: 5, rows: 7, column: 28, cell: 60, guide: '2-5 columns, the first naming each row\'s item; 2-7 rows of short cells' }),
      speaker_notes: notes(),
    },
  },
  diagram: {
    label: 'Diagram', description: 'Flowchart, sequence or structure', picture: false, sourced: true,
    use: 'A process with decisions or branches, a hand-off between people or systems, or a structure.',
    fields: {
      title: text(60, 'the slide\'s point as a short statement'),
      diagram_type: choice('diagramTypes', 'the kind of diagram'),
      mermaid_code: code('the diagram'),
      caption: text(140, 'one sentence telling the audience what the diagram shows'),
      speaker_notes: notes(),
    },
  },
  figure: {
    label: 'Figure', description: 'A figure from the documents', picture: false, sourced: true, figure: true,
    use: 'A figure from the documents is the main content: the slide walks through it.',
    fields: {
      title: text(60, 'what the audience should see in the figure'),
      caption: text(120, 'only for a figure the document gave no caption: a few plain words saying what it shows'),
      speaker_notes: notes(),
    },
  },
  closing: {
    label: 'Closing', description: 'Takeaways and next step', position: 'last', picture: false, sourced: false,
    use: 'The final slide.',
    fields: {
      title: text(60, 'signals the wrap-up'),
      takeaways: list(text(130, 'one key message of the deck as one sentence'), { min: 1, max: 5, write: '3-5 takeaways' }),
      call_to_action: text(140, 'one sentence on what to do next, or empty'),
      speaker_notes: notes(),
    },
  },
};

export const KIND_NAMES = Object.keys(KINDS);
export const DEFAULT_KIND = 'points';
export const FIRST_KIND = 'title';
export const LAST_KIND = 'closing';

// ── Icons ──
// A point's icon (points slides). The app picks it from what the point says, so each name has a meaning to
// match against. Images: shared/icons/<name>.png (white on transparent, drawn on an accent circle), built by
// scripts/build_icons.mjs from Lucide.
export const ICONS = {
  activity: 'activity, monitoring, signal, readings over time',
  'arrow-left-right': 'conversion, exchange, two-way, switching between units',
  atom: 'science, physics, chemistry, atoms',
  award: 'achievement, quality award, certification, recognition',
  ban: 'prohibited, do not, forbidden, avoid',
  battery: 'battery, stored energy, charge',
  bolt: 'fastener, bolt, nut, assembly',
  'book-open': 'reading, manual, documentation, learning, definition',
  box: 'volume, capacity, container, package size',
  boxes: 'inventory, stock, parts, many items',
  brain: 'knowledge, thinking, understanding, memory',
  briefcase: 'business, job, work role',
  'building-2': 'company, building, facility, office',
  cable: 'cable, wiring, connection',
  calculator: 'calculation, formula, multiply, divide, compute a value',
  calendar: 'date, schedule, deadline, period',
  car: 'car, automotive, vehicle',
  'chart-column': 'statistics, comparison of values, bar chart, results',
  'chart-pie': 'share, proportion, percentage of a whole',
  check: 'done, correct, confirmed',
  'circle-check': 'requirement met, approved, pass',
  'circle-question-mark': 'question, unknown, troubleshooting question',
  'circuit-board': 'electronics, control unit, circuit',
  'clipboard-check': 'inspection, checklist done, verification',
  'clipboard-list': 'list of tasks, procedure, record sheet',
  clock: 'time, duration, timing',
  cloud: 'cloud, weather, online service',
  cog: 'mechanism, machine part, gears, mechanical operation',
  coins: 'cost, money, budget, price',
  compass: 'direction, navigation, orientation',
  construction: 'construction, work in progress, roadworks',
  cpu: 'computer, processor, electronic control',
  crosshair: 'precision, aim, exact point',
  cylinder: 'cylinder, tank, chamber, bore',
  'dollar-sign': 'money, revenue, cost, finance',
  drill: 'drilling, power tool, boring',
  droplet: 'liquid, fluid, oil, water, coolant',
  eye: 'visual inspection, look, observe, visibility',
  factory: 'manufacturing, plant, production',
  fan: 'fan, cooling, airflow, ventilation',
  'file-text': 'document, report, specification sheet',
  flag: 'milestone, goal, start or finish',
  flame: 'fire, combustion, heat, ignition',
  'flask-conical': 'chemical, laboratory, test sample',
  fuel: 'fuel, gasoline, diesel, refuelling',
  gauge: 'measurement, pressure, gauge reading, performance level',
  'git-compare': 'comparison, differences between two versions',
  globe: 'global, world, international',
  'graduation-cap': 'training, education, qualification',
  hammer: 'hand tool, repair, hammering',
  hand: 'manual work, by hand, stop, handling',
  handshake: 'agreement, partnership, cooperation',
  'hard-hat': 'safety at work, worker protection, site safety',
  'heart-pulse': 'health, wellbeing, medical',
  hourglass: 'waiting time, elapsed time, time running out',
  info: 'information, note, definition, background',
  key: 'key point, access, essential element',
  layers: 'layers, levels, structure, stack',
  leaf: 'environment, sustainability, green',
  lightbulb: 'idea, tip, insight',
  'list-checks': 'checklist, requirements, criteria',
  lock: 'security, locked, restricted, lock-out',
  mail: 'email, message, communication',
  'map-pin': 'location, site, position',
  megaphone: 'announcement, communication, alert to staff',
  'message-square': 'discussion, feedback, comment',
  microscope: 'analysis, close examination, research',
  network: 'network, connections, system links',
  package: 'part, delivery, package',
  percent: 'percentage, rate, ratio',
  plane: 'aircraft, aviation, air travel',
  plug: 'power supply, electrical connection',
  puzzle: 'component fitting together, integration, problem solving',
  recycle: 'recycling, reuse, cycle',
  'refresh-cw': 'cycle, repeat, renewal, rotation',
  rocket: 'launch, fast growth, start',
  route: 'route, path, journey, flow',
  ruler: 'length, dimension, measuring distance or diameter',
  scale: 'balance, weight, compliance, rules',
  search: 'search, find, investigate, diagnose',
  server: 'server, data storage, IT system',
  settings: 'settings, adjustment, configuration',
  shield: 'protection, defence, guard',
  'shield-alert': 'hazard, safety risk, danger warning',
  'shield-check': 'safety confirmed, protected, compliant',
  ship: 'ship, marine, shipping',
  sigma: 'sum, total, adding up',
  star: 'highlight, important, best',
  sun: 'sun, daylight, solar, heat',
  target: 'goal, objective, target value',
  thermometer: 'temperature, heat, cooling',
  'thumbs-up': 'good practice, recommended, do',
  timer: 'timing, stopwatch, interval',
  'tool-case': 'tool kit, equipment, maintenance kit',
  tractor: 'agriculture, heavy vehicle, farm machinery',
  'trending-down': 'decrease, decline, fall',
  'trending-up': 'increase, growth, rise',
  'triangle-alert': 'warning, caution, risk',
  truck: 'truck, transport, logistics',
  user: 'person, role, individual',
  'user-check': 'qualified person, approval by a person, responsibility',
  users: 'team, people, staff, group',
  wallet: 'spending, payment, wallet',
  warehouse: 'warehouse, storage, depot',
  wind: 'air, wind, ventilation, exhaust',
  workflow: 'workflow, process, sequence of stages',
  wrench: 'maintenance, repair, adjustment, servicing',
  zap: 'electricity, power, energy, spark',
};
export const ICON_NAMES = Object.keys(ICONS);

// ── Derived views of a kind ──

function walkFields(fields, visit, prefix = '') {
  for (const [name, f] of Object.entries(fields)) visit(name, f, prefix ? `${prefix}.${name}` : name);
}

/** The JSON schema the writer fills for a kind (icons and pictures are the app's, not the writer's). */
export function writerSchema(kindName, { diagramTypes = [] } = {}) {
  const toSchema = (f) => {
    switch (f.type) {
      case 'text': case 'notes': case 'code': return { type: 'string' };
      case 'choice': return { type: 'string', enum: f.options === 'diagramTypes' ? diagramTypes : f.options };
      case 'table': return null; // expanded below into columns + rows
      case 'list': {
        const item = f.item.type ? toSchema(f.item) : objectSchema(f.item);
        return { type: 'array', maxItems: f.max, items: item };
      }
      default: return { type: 'string' };
    }
  };
  const objectSchema = (fields) => {
    const properties = {};
    for (const [name, f] of Object.entries(fields)) {
      if (f.type === 'table') {
        properties.columns = { type: 'array', maxItems: f.columns, items: { type: 'string' } };
        properties.rows = { type: 'array', maxItems: f.rows, items: { type: 'array', items: { type: 'string' } } };
      } else properties[name] = toSchema(f);
    }
    return { type: 'object', properties, required: Object.keys(properties) };
  };
  return objectSchema(KINDS[kindName].fields);
}

/** Max characters per text, as paths fit.js understands ("points[].heading", "grid" → "columns[]", "rows[][]"). */
export function fieldLimits(kindName) {
  const limits = {};
  const visit = (fields, prefix) => {
    for (const [name, f] of Object.entries(fields)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (f.type === 'text') limits[path] = f.max;
      else if (f.type === 'table') { limits['columns[]'] = f.column; limits['rows[][]'] = f.cell; }
      else if (f.type === 'list') {
        if (f.item.type === 'text') limits[`${path}[]`] = f.item.max;
        else visit(f.item, `${path}[]`); // entries, which may hold a list themselves (sides[].points[])
      }
    }
  };
  visit(KINDS[kindName].fields, '');
  return limits;
}

/** How to fill a kind, for the writer: each field's purpose, then the lengths (kept apart from the wording). */
export function writeGuide(kindName) {
  const lines = [];
  const lengths = [];
  const describe = (fields, prefix) => {
    walkFields(fields, (name, f, path) => {
      if (f.type === 'notes' || f.type === 'code' || f.type === 'choice') return;
      if (f.type === 'text') {
        lines.push(`${path}: ${f.guide}.`);
        lengths.push(`${path} ${f.max}`);
      } else if (f.type === 'table') {
        lines.push(`columns and rows: ${f.guide}. Cells are short phrases.`);
        lengths.push(`each column heading ${f.column}`, `each cell ${f.cell}`);
      } else if (f.type === 'list') {
        lines.push(`${path}: ${f.write}.`);
        if (f.item.type === 'text') {
          lines.push(`each of ${path}: ${f.item.guide}.`);
          lengths.push(`each of ${path} ${f.item.max}`);
        } else describe(f.item, `${path}[]`);
      }
    }, prefix);
  };
  describe(KINDS[kindName].fields, '');
  return `${lines.join('\n')}\nLongest allowed, in characters: ${lengths.join('; ')}.`;
}

/** An empty entry for a list (what the editor adds). path: the list's field names, e.g. ['sides', 'points']. */
export function newEntry(kindName, path) {
  let f = KINDS[kindName]?.fields[path[0]];
  for (const name of path.slice(1)) f = f?.item?.[name];
  if (!f || f.type !== 'list') return '';
  if (f.item.type === 'text') return '';
  return Object.fromEntries(Object.entries(f.item).map(([k, sf]) => [k, sf.type === 'list' ? [''] : '']));
}

/** A list field's min and max entries. */
export function listBounds(kindName, path) {
  let f = KINDS[kindName]?.fields[path[0]];
  for (const name of path.slice(1)) f = f?.item?.[name];
  return f?.type === 'list' ? { min: f.min, max: f.max } : { min: 0, max: 0 };
}
