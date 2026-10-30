import test from 'node:test';
import assert from 'node:assert/strict';
import {isCanonicalAbsolutePath,isCanonicalArchivePath,readCanonicalUstar} from './archive-paths.mjs';
function archive(rows) {
  const chunks=[];
  for(const row of rows) {
    const data=Buffer.from(row.data??''),header=Buffer.alloc(512);let name=row.name,prefix=row.prefix??'';
    if(!prefix&&Buffer.byteLength(name)>100){const at=name.lastIndexOf('/');prefix=name.slice(0,at);name=name.slice(at+1);}
    assert.ok(Buffer.byteLength(name)<=100&&Buffer.byteLength(prefix)<=155);
    header.write(name,0,100);header.write(prefix,345,155);
    for(const[offset,length,value]of[[100,8,row.mode??0o444],[108,8,0],[116,8,0],[124,12,data.length],[136,12,0]])header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
    header.fill(32,148,156);header.write(row.type??'0',156);header.write('ustar\0',257);header.write(row.version??'00',263);
    header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
    chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));return Buffer.concat(chunks);
}
test('canonical Linux paths preserve the actual hidden evidence and source layout',()=>{
  assert.equal(isCanonicalAbsolutePath('/cases/case-a/.artifacts/nativeOutput'),true);
  assert.equal(isCanonicalAbsolutePath('/'),false);assert.equal(isCanonicalAbsolutePath('/',{allowRoot:true}),true);
  const names=['opt/source','opt/source/.artifacts','opt/source/.artifacts/natural-wave-preparation','opt/source/.artifacts/natural-wave-preparation/generation/runtime/derived-observer/host-main-ticketed.mjs'];
  const rows=names.map((name,index)=>({name,type:index===names.length-1?'0':'5',mode:index===names.length-1?0o444:0o555,data:index===names.length-1?'export const observer=true;':''}));
  const parsed=readCanonicalUstar(archive(rows));assert.deepEqual(parsed.map(row=>row.name),names);assert.equal(parsed.at(-1).data.toString(),'export const observer=true;');
});
for(const value of['./file','../file','safe/../file','/absolute','safe//file','safe/./file','safe\\file','safe/\u0000file','safe/\nfile','C:/absolute',''])test('archive path rejects '+JSON.stringify(value),()=>{
  assert.equal(isCanonicalArchivePath(value),false);assert.throws(()=>readCanonicalUstar(archive([{name:value}])));
});
for(const value of['relative','/safe/../file','/safe//file','/safe/./file','/safe/file/','/safe\\file','/safe/\nfile'])test('absolute path rejects '+JSON.stringify(value),()=>assert.equal(isCanonicalAbsolutePath(value),false));
test('archive rejects duplicate normalized names and directory aliases',()=>{
  assert.throws(()=>readCanonicalUstar(archive([{name:'same'},{name:'same'}])));
  assert.throws(()=>readCanonicalUstar(archive([{name:'same/',type:'5'},{name:'same'}])));
});
for(const type of['1','2','x','g','3','6'])test('archive rejects non-file/directory type '+type,()=>assert.throws(()=>readCanonicalUstar(archive([{name:'member',type}]))));
test('archive refuses a prefix traversal, data-bearing directory, checksum, padding and incomplete termination',()=>{
  assert.throws(()=>readCanonicalUstar(archive([{name:'file',prefix:'safe/..'}])));
  assert.throws(()=>readCanonicalUstar(archive([{name:'directory',type:'5',data:'hidden'}])));
  const checksum=archive([{name:'file'}]);checksum[100]^=1;assert.throws(()=>readCanonicalUstar(checksum));
  const padding=archive([{name:'file',data:'a'}]);padding[513]=1;assert.throws(()=>readCanonicalUstar(padding));
  const missing=archive([{name:'file'}]).subarray(0,1024);assert.throws(()=>readCanonicalUstar(missing));
});

test('archive requires exact USTAR version 00 even when the checksum is valid',()=>{for(const version of['01','  ','\0\0'])assert.throws(()=>readCanonicalUstar(archive([{name:'member',version}])));});

function updateChecksum(bytes){bytes.fill(32,148,156);bytes.write(bytes.subarray(0,512).reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');}
for(const [name,start]of[['mode',100],['uid',108],['gid',116],['size',124],['checksum',148]])test('numeric '+name+' field refuses data after its NUL even with a valid checksum',()=>{const bytes=archive([{name:'file'}]);if(name==='checksum'){bytes[155]=120;}else{bytes[start]=48;bytes[start+1]=0;bytes[start+2]=120;updateChecksum(bytes);}assert.throws(()=>readCanonicalUstar(bytes),/Tar number has data after NUL/);});
test('numeric fields require ASCII octal digits and space padding',()=>{for(const byte of[10,0xa0,0xb0,56]){const bytes=archive([{name:'file'}]);bytes[108]=byte;updateChecksum(bytes);assert.throws(()=>readCanonicalUstar(bytes),/Unsupported tar number/);}const spaces=archive([{name:'file'}]);spaces.fill(32,108,116);spaces[108]=48;spaces[109]=0;updateChecksum(spaces);assert.equal(readCanonicalUstar(spaces)[0].uid,0);});
