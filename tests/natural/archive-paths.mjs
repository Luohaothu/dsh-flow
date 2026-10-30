import assert from 'node:assert/strict';
import path from 'node:path';
import {TextDecoder} from 'node:util';

const invalid = /[\\\x00-\x1f\x7f]/u;
const components = value => value.split('/').every(part => part && part !== '.' && part !== '..');
export function isCanonicalAbsolutePath(value,{allowRoot=false}={}) {
  return typeof value === 'string' && !invalid.test(value) && path.posix.isAbsolute(value)
    && path.posix.resolve(value) === value && (value === '/' ? allowRoot : components(value.slice(1)));
}
export function isCanonicalArchivePath(value) {
  return typeof value === 'string' && value.length > 0 && !invalid.test(value)
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/u.test(value)
    && path.posix.normalize(value) === value && components(value);
}

// Reads metadata and original buffers only. It never extracts archive paths.
export function readCanonicalUstar(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 1024 && bytes.length % 512 === 0,'Incomplete tar');
  const decoder = new TextDecoder('utf-8',{fatal:true}),entries=[],names=new Set();
  const text = (header,start,size) => {
    const field=header.subarray(start,start+size),zero=field.indexOf(0);
    if((start===0||start===345)&&zero>=0)assert.ok(field.subarray(zero).every(byte=>byte===0),'Tar name has data after NUL');
    return decoder.decode(zero < 0 ? field : field.subarray(0,zero));
  };
  const octal = (header,start,size) => {
    const value=text(header,start,size).trim();assert.match(value,/^[0-7]*$/u,'Unsupported tar number');
    const number=Number.parseInt(value || '0',8);assert.ok(Number.isSafeInteger(number));return number;
  };
  for(let offset=0;offset<bytes.length;) {
    const header=bytes.subarray(offset,offset+512);
    if(header.every(byte=>byte===0)) {
      assert.ok(bytes.length-offset>=1024 && bytes.subarray(offset).every(byte=>byte===0),'Invalid tar terminator');
      return entries;
    }
    assert.equal(text(header,257,6),'ustar','Only USTAR is supported');assert.equal(text(header,263,2),'00','Only USTAR version 00 is supported');
    const checksum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0);
    assert.equal(octal(header,148,8),checksum,'Tar checksum differs');
    const prefix=text(header,345,155),rawName=(prefix?prefix+'/':'')+text(header,0,100);
    const name=rawName.endsWith('/')?rawName.slice(0,-1):rawName;
    assert.ok(isCanonicalArchivePath(name) && !names.has(name),'Unsafe or duplicate tar member');names.add(name);
    const type=text(header,156,1)||'0',size=octal(header,124,12),padded=Math.ceil(size/512)*512;
    assert.ok(['0','5'].includes(type) && offset+512+padded<=bytes.length,'Unsupported tar member');assert.ok(!rawName.endsWith('/')||type==='5','Only directory names may end in a separator');
    assert.ok(type!=='5'||size===0,'Directory tar member contains data');
    assert.ok(bytes.subarray(offset+512+size,offset+512+padded).every(byte=>byte===0),'Tar padding differs');
    entries.push({name,type,mode:octal(header,100,8),uid:octal(header,108,8),gid:octal(header,116,8),data:bytes.subarray(offset+512,offset+512+size)});
    offset+=512+padded;
  }
  throw new Error('Missing tar terminator');
}
