import assert from 'node:assert/strict';
import {
  buildLongformPlanPrompt,
  longformChapterLayout,
  materializeLongformPlan,
} from '../src/broadcast/longform/prompts.js';
import type { SpokenProgrammeConfig } from '../src/settings/vocab.js';

const spoken: SpokenProgrammeConfig = {
  enabled: true,
  format: 'current-events',
  prompt: 'A calm review of the week in science and public policy.',
  targetMinutes: 30,
  useWeb: true,
  musicBreaks: 2,
};

const layout = longformChapterLayout(spoken);
assert.ok(layout.chapterCount >= 3);
assert.equal(layout.breakAfter.size, 2);
assert.equal(layout.spokenSeconds, 22 * 60);
assert.equal(layout.spokenSeconds + layout.breakAfter.size * 4 * 60, spoken.targetMinutes * 60);
assert.equal(layout.targetSeconds.reduce((sum, seconds) => sum + seconds, 0), layout.spokenSeconds);
assert.ok([...layout.breakAfter].every((ordinal) => ordinal < layout.chapterCount - 1));

const prompt = buildLongformPlanPrompt(spoken, {
  showName: 'The Long View',
  showTopic: 'Ideas worth sitting with',
  hostName: 'Ari',
  stationName: 'SUB/WAVE',
  language: 'English',
  nowIso: '2026-07-30T18:00:00.000Z',
}, layout);
assert.match(prompt.prompt, new RegExp(`exactly ${layout.chapterCount}`));
assert.match(prompt.prompt, /web-search queries/i);
assert.match(prompt.prompt, /about 4 minutes/);
assert.match(prompt.prompt, /22 minutes of narration within the 30-minute programme block/);

const planned = Array.from({ length: layout.chapterCount }, (_, index) => ({
  title: `Part ${index + 1}`,
  brief: `Cover angle ${index + 1} without repeating earlier material.`,
  researchQueries: [`angle ${index + 1} latest`],
}));
const parsed = prompt.schema.parse({ title: 'The week, considered', summary: 'A measured tour.', chapters: planned });
const result = materializeLongformPlan(parsed, spoken, layout);
assert.equal(result.chapters.length, layout.chapterCount);
assert.equal(result.chapters.filter((chapter) => chapter.metadata?.musicAfter === true).length, 2);
assert.ok(result.chapters.every((chapter) => chapter.researchRequired));
assert.deepEqual(result.chapters.map((chapter) => chapter.id).slice(0, 2), ['chapter-01', 'chapter-02']);

const noBreaks = longformChapterLayout({ ...spoken, targetMinutes: 1, useWeb: false, musicBreaks: 0 });
assert.equal(noBreaks.breakAfter.size, 0);
assert.ok(noBreaks.chapterCount >= 1);

for (let targetMinutes = 1; targetMinutes <= 180; targetMinutes++) {
  for (let musicBreaks = 0; musicBreaks <= 12; musicBreaks++) {
    const candidate = longformChapterLayout({ ...spoken, targetMinutes, musicBreaks });
    const feasibleBreaks = Math.min(musicBreaks, Math.floor((targetMinutes - 1) / 5));
    assert.equal(candidate.breakAfter.size, feasibleBreaks);
    assert.equal(
      candidate.spokenSeconds + candidate.breakAfter.size * 4 * 60,
      targetMinutes * 60,
    );
    assert.ok(candidate.targetSeconds.every((seconds) => seconds >= 60));
  }
}

// The runtime stays safe even if old/hand-edited state bypasses strict saves:
// it keeps only the breaks that leave one spoken minute per resulting act.
const impossibleBreaks = { ...spoken, targetMinutes: 10, useWeb: false, musicBreaks: 12 };
const feasibleLayout = longformChapterLayout(impossibleBreaks);
assert.equal(feasibleLayout.breakAfter.size, 1);
assert.equal(feasibleLayout.spokenSeconds, 6 * 60);
assert.equal(feasibleLayout.spokenSeconds + feasibleLayout.breakAfter.size * 4 * 60, 10 * 60);
assert.ok(feasibleLayout.targetSeconds.every((seconds) => seconds >= 60));

const feasiblePrompt = buildLongformPlanPrompt(impossibleBreaks, {
  showName: 'The Long View',
  showTopic: '',
  hostName: 'Ari',
  stationName: 'SUB/WAVE',
  language: 'English',
  nowIso: '2026-07-30T18:00:00.000Z',
}, feasibleLayout);
const feasiblePlanned = Array.from({ length: feasibleLayout.chapterCount }, (_, index) => ({
  title: `Part ${index + 1}`,
  brief: `Angle ${index + 1}`,
  researchQueries: [],
}));
const feasibleResult = materializeLongformPlan(
  feasiblePrompt.schema.parse({ title: 'Feasible', summary: 'One song only.', chapters: feasiblePlanned }),
  impossibleBreaks,
  feasibleLayout,
);
assert.equal(feasibleResult.metadata?.musicBreaks, 1);
assert.equal(feasibleResult.chapters.filter((chapter) => chapter.metadata?.musicAfter === true).length, 1);

console.log('\x1b[32m✓ longform prompt/layout contract\x1b[0m');
