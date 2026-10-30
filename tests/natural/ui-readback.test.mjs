import test from 'node:test';
import assert from 'node:assert/strict';
import {captureUiReadback} from './ui-readback.mjs';

test('without a pattern, a nonempty value is returned byte for byte',()=>{
  for(const value of ['B','  B  ','\n模型 B\n']) assert.equal(captureUiReadback(value),value);
});
test('captures the bare identity from a session attribute',()=>{
  assert.equal(captureUiReadback('session:main-id',{pattern:'^session:(.+)$'}),'main-id');
});
test('captures from URL text without a browser dependency',()=>{
  assert.equal(captureUiReadback('https://example.invalid/session/main-id',{pattern:'/session/([^/?#]+)$'}),'main-id');
});
test('captures text and selects the first group only',()=>{
  assert.equal(captureUiReadback('model=B;extra=C',{pattern:'^model=(B);extra=(C)$'}),'B');
});
test('rejects missing, nonstring and empty raw values',()=>{
  for(const value of [null,undefined,0,{},'', ' \n ']) assert.throws(()=>captureUiReadback(value));
});
test('rejects an empty or nonstring explicit pattern',()=>{
  for(const pattern of ['',null,3,{},/B/u]) assert.throws(()=>captureUiReadback('B',{pattern}));
});
test('rejects invalid regular expressions',()=>assert.throws(()=>captureUiReadback('B',{pattern:'['}),SyntaxError));
test('rejects an unmatched pattern',()=>assert.throws(()=>captureUiReadback('foreign:main-id',{pattern:'^session:(.+)$'})));
test('rejects a match without a capture group',()=>assert.throws(()=>captureUiReadback('B',{pattern:'^B$'})));
test('rejects empty, whitespace and absent first captures',()=>{
  for(const [value,pattern] of [['session:','^session:(.*)$'],['session:  ','^session:(.+)$'],['B','^(A)?B$']]) assert.throws(()=>captureUiReadback(value,{pattern}));
});
