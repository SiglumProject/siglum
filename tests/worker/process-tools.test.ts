import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createToolRegistry, ProcessToolSession, PROCESS_TOOL_MAILBOX_BYTES, validateProcessResult } from '../../src/process-tools.js';
const source = readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8');
const workerCode = `
 const {parentPort,workerData}=require('node:worker_threads');
 const {createContext,runInContext}=require('node:vm');
 const context=createContext({self:{postMessage(){}},Uint8Array,TextDecoder,TextEncoder,Map,Set,Atomics,SharedArrayBuffer,Int32Array,performance,setTimeout,clearTimeout});
 runInContext(workerData.source,context);
 const files=new Map([['/main.tex',new Uint8Array([7])],['/project.txt',new Uint8Array([8])],['/compiler/readonly.sty',new Uint8Array([9])]]),dirs=new Set(['/','/compiler']);
 const FS={open(path,flags){return {path,flags:flags==='w'?1:0}},readFile(path){if(!files.has(path))throw Error('Missing file');return files.get(path).slice()},writeFile(path,bytes){if(workerData.failWrite===path){workerData.failWrite=null;throw Error('Injected storage failure')}this.open(path,'w');files.set(path,bytes.slice())},lookupPath(path){if(files.has(path))return {node:{mode:'file'}};if(dirs.has(path))return {node:{mode:'dir'}};throw Error('Missing path')},isDir:mode=>mode==='dir',mkdirTree(path){for(let p=path;p&&p!=='/';p=p.slice(0,p.lastIndexOf('/'))||'/')dirs.add(p)},unlink(path){if(!files.delete(path))throw Error('Missing file')},rmdir(path){dirs.delete(path)}};
 context.module={FS};context.project=new Map([['/project.txt',new Uint8Array([8])]]);context.buffer=workerData.buffer;
 context.send=(message,transfer)=>parentPort.postMessage(message,transfer);
 runInContext("access=createToolFileAccess(module,'/','/main.tex',project,new Set(),new Map()); module.FS.writeFile('/opaque-request.bin',new Uint8Array([1,2,3]));",context);
 const exit=runInContext("receiveToolProcess({buffer,compileId:'1',command:'test-tool',args:['opaque-request.bin'],files:access,postMessage:send,log:()=>{}})",context);
 parentPort.postMessage({type:'finished',exit,files:[...files].map(([path,data])=>({path,data:Array.from(data)})),dirs:[...dirs]});
`;
async function run(provider, configure = (_controller) => {}, failWrite = null) {
 const buffer = new SharedArrayBuffer(PROCESS_TOOL_MAILBOX_BYTES), controller = new AbortController();
 const worker = new Worker(workerCode,{eval:true,workerData:{source,buffer,failWrite}});
 const session = new ProcessToolSession({worker,buffer,compileId:'1',registry:createToolRegistry([{command:'test-tool',run:provider}]),projectFiles:new Map([['project.txt',new Uint8Array([8])]]),mainFile:'main.tex',signal:controller.signal,current:()=>true});
 configure(controller);
 try { return await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',message=>{if(message.type==='process-tool-request')void session.execute(message);else if(message.type==='process-tool-frame')session.onMessage(message);else if(message.type==='finished')resolve(message)})}); }
 finally {controller.abort();await worker.terminate()}
}
describe('generic process tools over a real blocking worker',()=>{
 it('reads arbitrary generated/project inputs and streams more than one mailbox of output',async()=>{
  const bytes=new Uint8Array(1024*1024+19).fill(42);
  const result:any=await run(async(request,context)=>{expect(request.args).toEqual(['opaque-request.bin']);expect(await context.readFile('opaque-request.bin')).toEqual(new Uint8Array([1,2,3]));expect(context.readProjectFile('project.txt')).toEqual(new Uint8Array([8]));return {files:[{path:'first.bin',bytes:new Uint8Array([4,5])},{path:'large.bin',bytes},{path:'empty.bin',bytes:new Uint8Array()}]}});
  expect(result.exit).toBe(0);expect(result.files.find(f=>f.path==='/large.bin').data).toHaveLength(bytes.length);expect(result.files.find(f=>f.path==='/large.bin').data.every(x=>x===42)).toBe(true);
 });
 it.each(['main.tex','project.txt','compiler/readonly.sty','compiler/new.sty','../outside'])('rejects protected output %s before any write',async path=>{
  const result:any=await run(()=>({files:[{path:'would-be-first.txt',bytes:new Uint8Array([1])},{path,bytes:new Uint8Array([2])}]}));
  expect(result.exit).not.toBe(0);expect(result.files.some(f=>f.path==='/would-be-first.txt')).toBe(false);expect(result.files.find(f=>f.path==='/main.tex').data).toEqual([7]);
 });
 it('denies reads of compiler files that are not project/build inputs',async()=>{
  const result:any=await run(async(_,context)=>{await context.readFile('compiler/readonly.sty');return {}});expect(result.exit).not.toBe(0);
 });
 it('rolls back earlier writes and newly created directories after a partial filesystem failure',async()=>{
  const result:any=await run(()=>({files:[{path:'opaque-request.bin',bytes:new Uint8Array([99])},{path:'new/sub/failure.bin',bytes:new Uint8Array([100])}]}),()=>{},'/new/sub/failure.bin');
  expect(result.exit).not.toBe(0);expect(result.files.find(f=>f.path==='/opaque-request.bin').data).toEqual([1,2,3]);expect(result.files.some(f=>f.path==='/new/sub/failure.bin')).toBe(false);expect(result.dirs).not.toContain('/new');expect(result.dirs).not.toContain('/new/sub');
 });
 it('discards all partial outputs and removals from a failed external program',async()=>{
  const result:any=await run(()=>({exitCode:42,files:[{path:'opaque-request.bin',bytes:new Uint8Array([99])},{path:'new/partial.table',bytes:new Uint8Array([42])}],removed:['prior-output.bin']}));
  expect(result.exit).toBe(42);expect(result.files.find(f=>f.path==='/opaque-request.bin').data).toEqual([1,2,3]);expect(result.files.some(f=>f.path==='/new/partial.table')).toBe(false);expect(result.dirs).not.toContain('/new');
 });
 it('preserves explicit nonzero tool exits',async()=>{
  const result:any=await run(()=>({exitCode:42}));expect(result.exit).toBe(42);
 });
 it('cancels a stuck provider and wakes the blocked worker',async()=>{
  const result:any=await run(()=>new Promise(()=>{}),controller=>{setTimeout(()=>controller.abort(),100)});expect(result.exit).not.toBe(0);
 });
});
describe('provider/result contracts',()=>{
 it('rejects duplicate command registration and copies caller configuration',()=>{
  const entry:any={command:'test-tool',run:()=>({})};const registry=createToolRegistry([entry]);entry.command='other';expect(registry.has('test-tool')).toBe(true);expect(()=>createToolRegistry([entry,entry])).toThrow('Duplicate');
 });
 it.each([256,-1,1.5,NaN])('rejects invalid exits %j',exitCode=>expect(()=>validateProcessResult({exitCode})).toThrow());
 it('rejects overlapping removals and generated files',()=>expect(()=>validateProcessResult({files:[{path:'x',bytes:new Uint8Array()}],removed:['x']})).toThrow());
});

describe('compile revision isolation',()=>{
 it('does not publish a late result into a subsequent compile mailbox',async()=>{
  let resolveTool;
  const buffer=new SharedArrayBuffer(PROCESS_TOOL_MAILBOX_BYTES),header=new Int32Array(buffer,0,8),controller=new AbortController();
  Atomics.store(header,1,1);let current=true;
  const session=new ProcessToolSession({worker:{},buffer,compileId:'one',registry:createToolRegistry([{command:'test-tool',run:()=>new Promise(resolve=>{resolveTool=resolve})}]),projectFiles:new Map(),mainFile:'main.tex',signal:controller.signal,current:()=>current});
  const promise=session.execute({compileId:'one',sequence:1,command:'test-tool',args:[]});await Promise.resolve();
  current=false;Atomics.store(header,1,2);resolveTool({});await promise;
  expect(Atomics.load(header,1)).toBe(2);expect(Atomics.load(header,0)).toBe(0);
 });
});

describe('executable naming', () => {
 it.each(['Rscript','python3.12','custom_tool','c++'])('registers an explicit executable identifier %s',command=>{
  expect(createToolRegistry([{command,run:()=>({})}]).has(command)).toBe(true);
 });
 it.each(['bad;cmd','/usr/bin/tool','../tool','two words','cmd,other'])('rejects shell/path injection %s',command=>{
  expect(()=>createToolRegistry([{command,run:()=>({})}])).toThrow();
 });
});
