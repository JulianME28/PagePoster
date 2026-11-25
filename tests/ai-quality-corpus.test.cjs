'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const corpus = require('./fixtures/ai-quality-corpus-v1.json');

const nearCopyThreshold = 0.8;
const minimumPhrases = 60;
const phraseLength = 5;

const providerResponse = plan => ({
  status: 'completed',
  output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(plan)}]}]
});

function articlePhrases(sections) {
  const phrases = new Set();
  for (const {body} of sections) {
    for (const paragraph of body.split(/\n\s*\n/)) {
      // The current planner appends link insertion sentences as their own paragraphs.
      if (paragraph.includes('[[PP_LINK:')) continue;
      const words = paragraph.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
      for (let index = 0; index + phraseLength <= words.length; index++) {
        phrases.add(words.slice(index, index + phraseLength).join(' '));
      }
    }
  }
  return phrases;
}

function compareArticles(left, right) {
  const leftPhrases = articlePhrases(left.sections);
  const rightPhrases = articlePhrases(right.sections);
  const smaller = Math.min(leftPhrases.size, rightPhrases.size);
  if (smaller < minimumPhrases) return null;
  let shared = 0;
  for (const phrase of leftPhrases) {
    if (rightPhrases.has(phrase)) shared++;
  }
  return shared / smaller;
}

test('offline comparison separates lightly edited copies from independent articles across five languages', async t => {
  const {pagePlannerContract} = await import('../server/lifecycle/ai-page-planner.mjs');
  assert.equal(corpus.version, 1);
  for (const [language, example] of Object.entries(corpus.cases)) {
    await t.test(language + '/' + example.geo, () => {
      const fixture = require('./fixtures/languages/' + language + '.json');
      const input = {...fixture.input, variation: 'editorial-v2:0:corpus'};
      assert.equal(input.editorial.topic, corpus.topic);
      const parse = (plan, variation, format = input.editorial.format) => pagePlannerContract.parse(
        providerResponse(plan), {...input, variation, editorial: {...input.editorial, format}}
      );
      const base = parse(fixture.plan, input.variation);
      const copy = structuredClone(fixture.plan);
      copy.sections.reverse();
      copy.sections[0].body = copy.sections[0].body.replace(/^\S+(?:\s+\S+){3}/u, '') + '\n\n' + example.independent[0];
      const edited = parse(copy, 'editorial-v2:1:corpus', example.format);

      assert.equal(base.quality.state, 'passed');
      assert.equal(edited.quality.state, 'passed');
      assert.equal(edited.config.editorialFormat, example.format);
      assert.equal(edited.config.language, language);
      assert.deepEqual(edited.config.aiLinkInsertions.map(({url, anchor}) => ({url, anchor})), input.links);
      assert.notEqual(base.quality.generatedTextFingerprint, edited.quality.generatedTextFingerprint);
      const score = compareArticles(base.config, edited.config);
      assert.ok(score >= nearCopyThreshold, 'lightly edited copy scored ' + score);

      const rewritten = structuredClone(edited.config);
      rewritten.sections[0].body = example.independent.join('\n\n');
      const rewrittenScore = compareArticles(base.config, rewritten);
      assert.ok(rewrittenScore >= nearCopyThreshold, 'copy with one rewritten section scored ' + rewrittenScore);

      // Keep the same chrome, CTA and FAQ while providing independently written prose.
      const independent = {...base.config, sections: example.independent.map(body => ({body}))};
      const independentScore = compareArticles(base.config, independent);
      assert.ok(independentScore !== null && independentScore < nearCopyThreshold, 'independent article scored ' + independentScore);
      assert.equal(independentScore, compareArticles(independent, base.config));
      const linkParagraph = base.config.sections[0].body.split(/\n\s*\n/).find(text => text.includes('[[PP_LINK:'));
      assert.ok(linkParagraph);
      independent.sections[0].body += '\n\n' + linkParagraph;
      assert.equal(compareArticles(base.config, independent), independentScore);
      const sharedSection = {...independent, sections: [...independent.sections, base.config.sections[0]]};
      const sharedScore = compareArticles(base.config, sharedSection);
      assert.ok(sharedScore > 0 && sharedScore < nearCopyThreshold, 'independent article with one shared section scored ' + sharedScore);
      t.diagnostic(language + ' edited=' + score.toFixed(3) + ' rewritten=' + rewrittenScore.toFixed(3) +
        ' independent=' + independentScore.toFixed(3) + ' shared-section=' + sharedScore.toFixed(3));
    });
  }
});

test('short fragments yield no overlap verdict', () => {
  const fragment = {sections: [{body: 'Une main de poker jouée hier.'}]};
  assert.equal(compareArticles(fragment, fragment), null);
});
