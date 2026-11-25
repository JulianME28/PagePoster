'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {tapSummary}=require('../scripts/verify-release.cjs');

test('release gate requires one complete TAP summary with every test passing',()=>{
  const green='# tests 20\n# pass 20\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(tapSummary(green).pass,20);
  assert.throws(()=>tapSummary(green.replace('# skipped 0','# skipped 1')),/all tests/);
  assert.throws(()=>tapSummary(green.replace('# cancelled 0','# cancelled 1')),/all tests/);
  assert.throws(()=>tapSummary(green.replace('# pass 20','# pass 19')),/all tests/);
  assert.throws(()=>tapSummary(green.replace('# fail 0\n','')),/TAP count/);
  assert.throws(()=>tapSummary(green+green),/TAP count/);
});
