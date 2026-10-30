import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=file=>typeof file==='string'&&file.startsWith('/')&&file!=='/'&&!file.includes('\\')&&!/[\x00-\x1f\x7f]/u.test(file)&&file.split('/').slice(1).every(part=>part&&part!=='.'&&part!=='..');
function target(containerId,file){assert.match(containerId,/^[a-f0-9]{64}$/u);assert.ok(canonical(file),'Canonical Root copy path required');return containerId+':'+file;}
/** Read raw tar from the exact physical target. The caller still validates every tar member. */
export function rootOwnedReadArgs({containerId,file}){return Object.freeze(['container','cp',target(containerId,file),'-']);}
/** Default stdin extraction creates Root-owned files; archive-write ownership must not be assumed. */
export function rootOwnedFileCopy({containerId,directory,fileName,sha256,mode=0o444}){
 assert.ok(typeof fileName==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(fileName)&&!['.','..'].includes(fileName));assert.match(sha256,/^[a-f0-9]{64}$/u);assert.equal(mode,0o444,'Frozen Root file is read-only');
 return Object.freeze({writeArgs:Object.freeze(['container','cp','-',target(containerId,directory)]),readArgs:rootOwnedReadArgs({containerId,file:directory+'/'+fileName}),expected:Object.freeze({name:fileName,type:'0',uid:0,gid:0,mode,sha256})});
}
/** Operates on the caller's parsed raw tar, never on command success or declared input ownership. */
export function assertRootOwnedFileReadback(members,expected){
 assert.equal(expected.type,'0');assert.equal(expected.uid,0);assert.equal(expected.gid,0);assert.equal(expected.mode,0o444);assert.match(expected.sha256,/^[a-f0-9]{64}$/u);assert.ok(Array.isArray(members)&&members.length===1,'Expected one Root-owned file');const row=members[0];
 for(const field of['name','type','uid','gid','mode'])assert.equal(row[field],expected[field],'Root file '+field+' differs');assert.ok(Buffer.isBuffer(row.data),'Original file bytes required');assert.equal(hash(row.data),expected.sha256,'Root file bytes differ');return row;
}
