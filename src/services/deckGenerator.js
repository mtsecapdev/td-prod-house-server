import config from '../config.js';
import { generateStructured, chatStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { updateGenerationDb } from '../db/generationsQueries.js';
import { LAYOUT_SCHEMAS, LAYOUT_TYPES } from './slideSchemas.js';

const SLIDE_COUNTS = { quick: [3, 5], standard: [6, 10], deep: [12, 18] };

const outlineSchema = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:  { type: 'string' },
          intent: { type: 'string' },
          layout: {
            type: 'string',
            enum: LAYOUT_TYPES,
          },
        },
        required: ['title', 'intent', 'layout'],
      },
    },
  },
  required: ['slides'],
};

function getSystemPrompt(layout) {
  const base =
    'You are an expert instructional designer creating a professional corporate training slide. ' +
    'Use only the source material provided. ' +
    'Quality standards:\n' +
    '- SPECIFICITY: Replace vague language with concrete details from the source. "Significant improvement" → "47% reduction in downtime". Every claim needs a number, name, or measurable outcome.\n' +
    '- NO FILLER: Cut phrases like "it is important to note", "as we all know", "in today\'s environment". Every word earns its place.\n' +
    '- PARALLEL STRUCTURE: Bullets, steps, and items follow the same grammatical pattern.\n' +
    '- TITLES NAME THE INSIGHT: "Engine Room Safety" → "3 Failures Behind 80% of Engine Room Injuries".\n' +
    '- SPEAKER NOTES ARE A SCRIPT: Include talking points, transition cues, audience questions, and data that doesn\'t fit on the slide. 4-6 sentences minimum.';

  const instructions = {
    title:
      `${base}\nWrite a compelling, action-oriented title (max 8 words) and a subtitle that frames the deck's value proposition for the audience. The subtitle should tell them what they will be able to DO after this training.`,
    bullets:
      `${base}\nWrite 3-5 punchy bullet points. Each bullet has a SHORT heading (2-5 words, like a label) and a one-sentence detail that gives the specific insight, fact, or action. Avoid generic advice — every detail should reference concrete information from the source. Write speaker notes that add context, examples, or talking points the presenter needs.`,
    two_column:
      `${base}\nOrganize the content into two distinct columns that create a meaningful comparison, contrast, or categorization. Each column needs a clear heading and 2-4 bullets. The contrast should be immediately obvious — don't just split a list in half. Write speaker notes explaining the significance of the comparison.`,
    stat_focus:
      `${base}\nIdentify the single most striking statistic or metric from the source material — one that would make the audience pause. The stat_value should be a number with its unit (e.g. "73%", "2.4x", "< 30 min"). The stat_label is 2-5 words naming what the stat measures. The context sentence explains why this number matters. Write speaker notes with additional data points and talking points.`,
    quote_highlight:
      `${base}\nExtract a key quote, principle, or doctrinal statement from the source material — something authoritative that anchors the training point. Quote it accurately with proper attribution (name, role, or document title). The commentary should explain why this quote matters for the audience's practice. Write speaker notes that help the presenter discuss the quote.`,
    checklist:
      `${base}\nCreate 4-6 clear, actionable steps forming a procedure or checklist. Each step name should start with a verb (e.g. "Verify", "Submit", "Confirm"). Each detail gives the specific how or what for that step. Steps should follow a logical sequence. Write speaker notes with tips, common mistakes, or additional detail per step.`,
    closing:
      `${base}\nWrite a strong closing slide. The title should signal wrap-up (e.g. "Key Takeaways", "Remember These"). List 3-5 concise takeaways — each one sentence summarizing the most important point from the deck. If appropriate, add a call_to_action — one sentence telling the audience what to do next. Write speaker notes that help the presenter close the session.`,
    section_divider:
      `${base}\nWrite a section divider slide that signals a shift to a new topic area. The title should name the upcoming section (2-5 words, bold and clear). The subtitle should prime the audience — tell them why this section matters or what they'll learn next. Keep it short and punchy.`,
    big_idea:
      `${base}\nDistil the slide's topic into ONE powerful statement — a principle, insight, or rule that the audience should remember above all else. The statement should be bold, quotable, and self-contained (max 15 words). The supporting line adds one sentence of context or evidence. Write speaker notes that unpack the idea with examples and discussion points.`,
    timeline:
      `${base}\nArrange the content as a chronological sequence of 3-6 events or milestones. Each event needs a date or time marker (a year, date, phase name, or relative time like "Day 1"), a short label (2-5 words), and an optional detail sentence. Events must be in chronological order. Write speaker notes that explain the significance of the timeline and transitions between events.`,
    process_flow:
      `${base}\nBreak the content into 3-6 sequential process steps. Each step has a short label (2-4 words, starts with a verb) and a detail sentence explaining what happens at that step. Steps must flow logically — the output of one feeds into the next. This is for PROCESSES and WORKFLOWS, not arbitrary lists. Write speaker notes covering decision points, exceptions, or tips per step.`,
    icon_grid:
      `${base}\nOrganize the content into 4-6 concept cards arranged in a grid. Each card has an icon keyword (a single word like "shield", "clock", "target", "users" — representing the concept visually), a short label (2-4 words), and a one-sentence description. Cards should be parallel in structure and roughly equal in weight. Write speaker notes that tie the concepts together.`,
    comparison_table:
      `${base}\nOrganize the content into a structured comparison table. Define 2-4 column headers and 3-6 rows of data. Each cell should be concise (a few words or a short phrase). The table should reveal a pattern, comparison, or decision matrix — not just dump data. Write speaker notes explaining how to read the table and what conclusions to draw.`,
  };

  return instructions[layout] || instructions.bullets;
}

const FEW_SHOT = {
  bullets: JSON.stringify({
    title: '3 Growth Engines Driving 18% Revenue CAGR',
    bullets: [
      { heading: 'Defence & Public Security', detail: 'Secured $4.2B in new contracts across land systems and cybersecurity, up 23% year-over-year.' },
      { heading: 'Commercial Aerospace', detail: 'MRO revenue reached $3.1B with fleet management covering 450+ aircraft globally.' },
      { heading: 'Urban Solutions', detail: 'Smart city projects in 6 ASEAN markets generating $890M recurring revenue at 34% gross margin.' },
    ],
    speaker_notes: 'Walk through each engine in order of revenue contribution. Emphasise that Defence is the largest but Commercial Aerospace is the fastest-growing at 28% CAGR. Ask the audience: which of these three do you think will be largest by 2030? The answer is Commercial Aerospace — the backlog already supports it. Transition to the next slide by noting that growth requires operational discipline.',
  }, null, 2),

  two_column: JSON.stringify({
    title: 'Legacy Fleet vs Next-Gen Fleet Economics',
    column_a_heading: 'Legacy Fleet (Pre-2015)',
    column_a_bullets: ['$18.2M avg maintenance cost per aircraft per year', 'Manual inspection cycles: 14-day turnaround', '68% parts availability rate from 3 regional warehouses'],
    column_b_heading: 'Next-Gen Fleet (2020+)',
    column_b_bullets: ['$11.4M avg maintenance cost — 37% reduction', 'Predictive maintenance: 5-day turnaround', '94% parts availability via global pooling network'],
    speaker_notes: 'The cost difference is stark — $6.8M per aircraft per year. For a fleet of 50 aircraft, that is $340M in annual savings. The key enabler is predictive maintenance powered by engine sensor data. Ask: how many of your current fleet are still on legacy maintenance cycles? This frames why the transition programme matters.',
  }, null, 2),

  stat_focus: JSON.stringify({
    title: 'MRO Capacity Drives Record Throughput',
    stat_value: '427',
    stat_label: 'Aircraft serviced in FY2024',
    context: 'A 31% increase over FY2023, driven by the new Pensacola widebody hangar adding 120,000 sq ft of capacity.',
    speaker_notes: 'This is the highest throughput in company history. Break it down: 267 narrowbody, 160 widebody. The Pensacola facility alone contributed 84 additional aircraft. Compare to the industry average turnaround of 45 days — ours is 32 days. The capacity expansion cost $180M but pays back in 3.2 years at current utilisation rates.',
  }, null, 2),

  checklist: JSON.stringify({
    title: '6-Step Engine Intake Inspection Protocol',
    items: [
      { step: 'Verify work order', detail: 'Cross-reference the engine serial number against the customer work order and confirm the scope of work (performance restoration vs. hot section only).' },
      { step: 'Photograph all quadrants', detail: 'Capture 360-degree photos of the inlet, exhaust, and all access panels before disassembly for the baseline condition report.' },
      { step: 'Run borescope inspection', detail: 'Insert borescope through ports 1-8 and record video of compressor blades, combustion chamber, and turbine stages.' },
      { step: 'Log foreign object damage', detail: 'Tag and catalogue any FOD findings with location, size, and severity rating (A/B/C) per the damage tolerance manual.' },
      { step: 'Complete fluid sampling', detail: 'Collect oil and fuel samples from designated ports, label with engine serial and date, submit to lab within 4 hours.' },
      { step: 'Sign off intake checklist', detail: 'Both the receiving technician and QA inspector must sign the digital checklist in SAP before the engine moves to disassembly bay.' },
    ],
    speaker_notes: 'Walk through each step and emphasise that skipping the photo documentation is the number one audit finding — it was flagged in 12% of intake events last year. The borescope step takes the longest (avg 45 minutes per engine) but catches 80% of hidden damage. Ask: what happens if FOD is found but not catalogued? Answer: the repair scope cannot be accurately quoted, leading to cost overruns averaging $120K per engine.',
  }, null, 2),

  timeline: JSON.stringify({
    title: 'From Regional Player to Global MRO Leader',
    events: [
      { date: '2010', label: 'Singapore hub opens', detail: 'First dedicated widebody MRO facility, 80,000 sq ft capacity.' },
      { date: '2015', label: 'US expansion', detail: 'Acquired VT Mobile Aerospace Engineering, adding 3 hangars in Pensacola.' },
      { date: '2019', label: 'China JV launched', detail: 'Joint venture with Chengdu Aerotech for narrowbody MRO, serving 120 airlines.' },
      { date: '2022', label: 'Digital transformation', detail: 'Deployed AI-based predictive maintenance across all facilities, reducing AOG events by 40%.' },
      { date: '2025', label: 'Pensacola Phase 2', detail: 'New widebody hangar adds 120,000 sq ft, bringing total capacity to 427 aircraft/year.' },
    ],
    speaker_notes: 'The story arc is: start in Asia, expand to the US for access to the world\'s largest aviation market, then add China for growth. The digital transformation in 2022 was the inflection point — it changed the business model from reactive to predictive. Note the 15-year timeline from regional to global. Ask: what took so long? Answer: MRO facilities require FAA/EASA/CAAS certification, which takes 2-3 years per site.',
  }, null, 2),

  process_flow: JSON.stringify({
    title: 'How a Contract Moves from Bid to Delivery',
    steps: [
      { label: 'Identify opportunity', detail: 'Business development flags RFPs from the $12B annual defence procurement pipeline and scores them on win probability.' },
      { label: 'Assemble bid team', detail: 'Cross-functional team of 8-12 specialists formed within 48 hours, led by a capture manager with domain expertise.' },
      { label: 'Submit proposal', detail: 'Technical and commercial volumes submitted 2 weeks before deadline, with independent cost review by Finance.' },
      { label: 'Negotiate terms', detail: 'Post-shortlist negotiations on delivery milestones, liquidated damages, and IP ownership — typically 3-6 rounds.' },
      { label: 'Execute delivery', detail: 'Programme manager activates the integrated master schedule, with monthly earned-value reviews against the $2.4M average contract value.' },
    ],
    speaker_notes: 'This is a simplified view of what is actually a 90-day average cycle from RFP to contract award. The bottleneck is usually step 3 — proposal writing consumes 60% of the elapsed time. We win roughly 1 in 4 bids, so pipeline volume matters. Ask the audience: at what stage do most bids fail? Answer: shortlisting — 70% are eliminated before negotiation begins, usually on technical compliance.',
  }, null, 2),

  icon_grid: JSON.stringify({
    title: '4 Strategic Pillars for 2025-2030',
    items: [
      { icon: 'shield', label: 'Defence & Security', description: 'Grow land systems and cybersecurity portfolio to $5.8B by 2030, anchored by 15-year sustainment contracts.' },
      { icon: 'plane', label: 'Commercial Aerospace', description: 'Expand MRO capacity to 600 aircraft/year across 5 global facilities with 95% utilisation target.' },
      { icon: 'cpu', label: 'Digital Solutions', description: 'Deploy AI/ML predictive platforms across all business units, targeting $400M in digital revenue by 2028.' },
      { icon: 'globe', label: 'Global Expansion', description: 'Enter 3 new markets (India, Saudi Arabia, Mexico) through JVs, adding $1.2B addressable market.' },
    ],
    speaker_notes: 'Each pillar has a named executive sponsor and a dedicated P&L. Defence is the most mature — already at $4.2B. Commercial Aerospace is the growth story. Digital Solutions is the newest pillar, created in 2023. Global Expansion is opportunistic — the 3 target markets were chosen because they have large defence budgets AND growing aviation sectors. Ask: which pillar has the highest margin? Answer: Digital Solutions at 42%, because it is largely software and analytics.',
  }, null, 2),

  comparison_table: JSON.stringify({
    title: 'Engine MRO Turnaround: Our Sites vs Industry',
    columns: ['Metric', 'Singapore', 'Pensacola', 'Chengdu', 'Industry Avg'],
    rows: [
      ['Avg turnaround (days)', '28', '32', '35', '45'],
      ['First-time fix rate', '94%', '91%', '88%', '82%'],
      ['Cost per shop visit', '$4.2M', '$3.8M', '$3.1M', '$5.0M'],
      ['Customer NPS', '72', '68', '65', '54'],
      ['Capacity (aircraft/yr)', '180', '160', '87', '—'],
    ],
    speaker_notes: 'Singapore leads on speed and quality because it is the oldest facility with the most experienced workforce. Pensacola wins on cost due to lower labour rates. Chengdu is ramping — expect its metrics to converge with Singapore by 2027 as the team matures. The industry average column is from the IATA MRO Survey 2024. Key talking point: our worst site still beats the industry average on every metric.',
  }, null, 2),

  big_idea: JSON.stringify({
    statement: 'Every 1% in utilisation is worth $28M annually.',
    supporting: 'Moving fleet utilisation from 89% to 94% over the next 3 years unlocks $140M in revenue without adding a single aircraft.',
    speaker_notes: 'This is the single most important number in the deck. Let it land — pause after reading the statement. The math: 450 aircraft × $6.2M avg annual revenue per aircraft × 1% = $27.9M, rounded to $28M. The 5-point improvement target is aggressive but achievable — predictive maintenance alone accounts for 2 of the 5 points. The remaining 3 come from schedule optimisation and reduced ferry flights. Ask: what is our current utilisation? Answer: 89.2% as of Q3.',
  }, null, 2),

  quote_highlight: JSON.stringify({
    title: 'The Mandate for Predictive Maintenance',
    quote_text: 'We will not renew any MRO contract that does not include real-time engine health monitoring by 2026.',
    attribution: 'VP Fleet Operations, Major Asian Carrier (2024 Contract Review)',
    commentary: 'This reflects a broader industry shift — 73% of airlines surveyed by IATA now require predictive maintenance as a contract baseline, up from 31% in 2020.',
    speaker_notes: 'This quote came from an actual contract negotiation with one of our top-5 customers. It was a wake-up call — we had offered a traditional MRO package and they rejected it. The 73% IATA figure is from the 2024 Airline Maintenance Cost Survey. For our business, this means every proposal we write from now on must include a digital monitoring component. The cost of adding it is roughly $200K per engine per year, but it reduces unscheduled removals by 35%.',
  }, null, 2),
};

function getUserPrompt(layout, slide, context) {
  const header = `Slide title: ${slide.title}\nSlide intent: ${slide.intent}\n\nSource material:\n${context}\n\n`;
  const example = FEW_SHOT[layout] ? `Here is an example of a high-quality ${layout} slide (different topic — match this level of specificity and detail, NOT the content):\n${FEW_SHOT[layout]}\n\nNow generate YOUR slide from the source material above:\n` : '';

  const directions = {
    title:           `${header}${example}Generate the title (max 8 words, action-oriented) and subtitle (one sentence, audience-focused).`,
    bullets:         `${header}${example}Generate 3-5 bullets. Each heading: 2-5 words, like a label. Each detail: one specific sentence with facts from the source. No filler. Plus speaker notes (4-6 sentences with examples/talking points).`,
    two_column:      `${header}${example}Generate two columns that contrast or categorize meaningfully. Each column: a clear heading and 2-4 concise bullets. Plus speaker notes explaining the comparison.`,
    stat_focus:      `${header}${example}Find the single most impactful number from the source material. stat_value: the number with unit. stat_label: 2-5 words. context: why it matters. Plus speaker notes with supporting data.`,
    quote_highlight: `${header}${example}Extract the most authoritative quote or principle from the source. Quote it accurately. Attribution: who said it or which document. Commentary: one sentence on why it matters. Plus speaker notes.`,
    checklist:       `${header}${example}Generate 4-6 steps in logical order. Each step name starts with a verb. Each detail: the specific how/what. Plus speaker notes with tips or common mistakes.`,
    closing:         `${header}${example}Generate 3-5 concise takeaways (one sentence each) summarizing the deck's most important points. Add a call_to_action if appropriate (one sentence, what to do next). Plus speaker notes for closing the session.`,
    section_divider: `${header}Generate a bold section title (2-5 words) and a subtitle that primes the audience for what's coming next (one sentence).`,
    big_idea:        `${header}${example}Distil the topic into ONE powerful statement (max 15 words, bold and quotable). Add a supporting sentence with evidence or context. Plus speaker notes unpacking the idea.`,
    timeline:        `${header}${example}Generate 3-6 events in chronological order. Each event: a date/time marker, a short label (2-5 words), and an optional detail sentence. Plus speaker notes on the timeline's significance.`,
    process_flow:    `${header}${example}Generate 3-6 sequential process steps. Each step: a verb-led label (2-4 words) and a detail sentence. Steps must flow logically. Plus speaker notes with tips and exceptions.`,
    icon_grid:       `${header}${example}Generate 4-6 concept cards. Each card: an icon keyword (one word like "shield", "clock", "target"), a label (2-4 words), and a one-sentence description. Plus speaker notes tying the concepts together.`,
    comparison_table:`${header}${example}Generate a comparison table: 2-4 column headers and 3-6 rows. Each cell: a concise phrase. The table should reveal a pattern or comparison. Plus speaker notes explaining how to read it.`,
  };

  return directions[layout] || directions.bullets;
}

export async function generateOutline(generation) {
  const { brief, source_document_ids: docIds } = generation;
  const { topic, audience, length, tone } = brief;
  const [min, max] = SLIDE_COUNTS[length] || SLIDE_COUNTS.standard;

  const topicEmbedding = await requestEmbedding(topic);
  const topicChunks = await getSimilarChunksDb(topicEmbedding, 10, docIds);

  const context = topicChunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const prompt =
    `You are an expert instructional designer building a professional training slide deck.\n\n` +
    `Topic: ${topic}\n` +
    (audience ? `Audience: ${audience}\n` : '') +
    (tone ? `Tone: ${tone}\n` : '') +
    `Slide count: ${min}–${max} slides\n\n` +
    `Available slide layouts and WHEN to use each:\n` +
    `- "title": Opening slide. Punchy title + value-proposition subtitle. ONLY for slide 1.\n` +
    `- "bullets": Core instructional content — concepts, principles, categories. The workhorse layout. Use when the slide explains or teaches something.\n` +
    `- "two_column": ONLY when the content has a genuine comparison, contrast, before/after, pros/cons, or two distinct categories. Do NOT use just to split a list in half.\n` +
    `- "stat_focus": ONLY when the source material contains a specific, striking number (a percentage, measurement, ratio, count) that is central to the training point. Do NOT use if the topic has no quantitative data.\n` +
    `- "quote_highlight": ONLY when the source material contains a verbatim quote, regulation excerpt, doctrine statement, or named principle worth calling out. Do NOT fabricate quotes.\n` +
    `- "checklist": ONLY when the content is a sequential procedure, step-by-step process, or ordered requirements. Do NOT use for unordered lists of facts.\n` +
    `- "section_divider": A visual break that signals a shift to a new topic area. Use in longer decks (8+ slides) to group related content into sections. Title names the section, subtitle primes the audience.\n` +
    `- "big_idea": ONE bold statement — a principle, insight, or rule the audience must remember. Use sparingly (max 1-2 per deck) for the single most important takeaway of a section.\n` +
    `- "timeline": Chronological sequence of 3-6 events or milestones. ONLY when the content has a natural time dimension (history, phases, schedule, evolution).\n` +
    `- "process_flow": Sequential workflow or process with 3-6 steps where each step feeds into the next. ONLY for genuine processes — not arbitrary lists.\n` +
    `- "icon_grid": 4-6 concept cards in a grid, each with an icon, label, and description. Use when presenting parallel concepts, categories, or capabilities of equal weight.\n` +
    `- "comparison_table": Structured table with columns and rows. ONLY when the content has structured data, specs, or a decision matrix that benefits from tabular presentation.\n` +
    `- "closing": Final slide. Wraps up with 3-5 key takeaways and an optional call to action. ONLY for the last slide.\n\n` +
    `Source material:\n${context}\n\n` +
    `Generate an outline. For each slide provide:\n` +
    `- title: A concise, specific slide title (max 8 words). Name the actual topic — avoid generic titles like "Introduction" or "Key Points".\n` +
    `- intent: One sentence describing what the audience should take away or be able to DO after this slide.\n` +
    `- layout: One of the layout types above, chosen because it genuinely fits the content.\n\n` +
    `Narrative flow rules:\n` +
    `- Slide 1 MUST be "title". The last slide MUST be "closing". No other slide should use "title" or "closing".\n` +
    `- Build a logical narrative: open with context/why it matters → teach the core content → close with takeaways.\n` +
    `- Choose layouts because the CONTENT demands them, not for variety. A deck of 3 bullets slides and a checklist is fine if that's what the material calls for. A forced stat_focus with a made-up number is not.\n` +
    `- "bullets" is the default. Only use a specialty layout (stat_focus, quote_highlight, two_column, checklist, timeline, process_flow, icon_grid, comparison_table, big_idea, section_divider) when the source material clearly supports it.\n` +
    `- Each slide should cover one distinct idea — never cram multiple topics into one slide.\n` +
    `- Use only information from the source material. Never invent statistics or quotes.\n` +
    `- Stay within the slide count range.`;

  const result = await generateStructured(prompt, config.ollama.generateModel, outlineSchema, { think: true });

  const slides = result.slides.map((s, i) => ({
    index: i,
    title: s.title,
    intent: s.intent,
    layout: LAYOUT_TYPES.includes(s.layout) ? s.layout : (i === 0 ? 'title' : 'bullets'),
    source_chunks: topicChunks.slice(0, 3).map((c) => ({
      chunk_id: c.id,
      page: c.page,
      preview: c.content.slice(0, 120),
    })),
  }));

  return { slides };
}

export async function generateSlideContent(generation, slideIndex) {
  const { outline, source_document_ids: docIds } = generation;
  const slide = outline.slides[slideIndex];
  if (!slide) throw new Error(`Slide ${slideIndex} not in outline`);

  const layout = slide.layout || 'bullets';
  const schema = LAYOUT_SCHEMAS[layout];
  if (!schema) throw new Error(`Unknown layout: ${layout}`);

  const slideEmbedding = await requestEmbedding(slide.title + ' ' + slide.intent);
  const chunks = await getSimilarChunksDb(slideEmbedding, 5, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const messages = [
    { role: 'system', content: getSystemPrompt(layout) },
    { role: 'user',   content: getUserPrompt(layout, slide, context) },
  ];

  const result = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });

  return {
    ...result,
    source_chunk_ids: chunks.map((c) => c.id),
  };
}

export async function generateAllSlides(generation, onProgress) {
  const { outline } = generation;
  const slides = [];

  for (let i = 0; i < outline.slides.length; i++) {
    if (onProgress) onProgress({ slide: i + 1, total: outline.slides.length, phase: 'slide', title: outline.slides[i].title, layout: outline.slides[i].layout });
    const content = await generateSlideContent(generation, i);
    slides.push({ ...outline.slides[i], content });
  }

  return slides;
}
