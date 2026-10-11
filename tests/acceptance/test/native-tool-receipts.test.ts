import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {readNativeToolReceipts} from '../native-tool-receipts.ts';

test('actual native file receipt remains readable when projection is a boolean',()=>{
  const reply=JSON.parse(readFileSync(new URL('../fixtures/native-file-receipt.json',import.meta.url),'utf8'));
  assert.equal(reply.projection,true);
  const [receipt]=readNativeToolReceipts(reply);
  assert(receipt);
  assert.equal((receipt.call as {name:string}).name,'read');
  assert.equal((receipt.ref as {call_seq:number}).call_seq,24);
  const message=(receipt.result as {message:{toolCallId:string;isError:boolean;content:{text:string}[]}}).message;
  assert.equal(message.toolCallId,'call_319fabf0');
  assert.equal(message.isError,false);
  assert.match(message.content.map(part=>part.text).join('\n'),/算术核验报告/);
});
