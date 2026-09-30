// 独立HTTP冒烟，不写会话数据库，不代表Tauri调度锁联调。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const endpoint = 'http://127.0.0.1:11434';
async function main() {
  const tags = await fetch(endpoint+'/api/tags', { signal: AbortSignal.timeout(10000) }).then(r=>r.json());
  const model = [...(tags.models || [])].sort((a,b)=>(a.size || Infinity)-(b.size || Infinity))[0]?.name;
  assert(model, '本机没有模型');
  const body = messages => ({model, messages, stream:true, think:false, options:{num_ctx:4096,num_predict:128}});
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),120000);
  let firstEvent = false;
  try {
    const response = await fetch(endpoint+'/api/chat',{method:'POST',body:JSON.stringify(body([{role:'user',content:'请从1开始逐个列出数字到100。'}])),headers:{'Content-Type':'application/json'},signal:controller.signal});
    assert(response.ok, '首次聊天HTTP '+response.status);
    for await (const chunk of response.body) {
      if (chunk.length) { firstEvent = true; controller.abort(); break; }
    }
  } catch (error) {
    if (!firstEvent || error.name !== 'AbortError') throw error;
  } finally { clearTimeout(timer); controller.abort(); }
  assert(firstEvent, '没有收到可取消的流事件');
  const retry = await fetch(endpoint+'/api/chat',{method:'POST',body:JSON.stringify({...body([{role:'user',content:'只回答OK。'}]),options:{num_ctx:4096,num_predict:8}}),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(120000)});
  assert(retry.ok, '取消后重发HTTP '+retry.status);
  const lines = (await retry.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert(lines.some(line=>line.done), '重发未完成');
  const missing = await fetch(endpoint+'/api/chat',{method:'POST',body:JSON.stringify({...body([]),model:'ollmin-ui-validation-missing-model:nonexistent'}),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)});
  assert.equal(missing.status,404);
  const report = {scope:'Actual local Ollama HTTP; no SQLite or Tauri scheduler invocation',model,firstStreamEvent:true,abortThenRetryDone:true,missingModelStatus:missing.status,elapsedMs:Date.now()-started};
  fs.mkdirSync('output/playwright/dsh-phase45',{recursive:true});
  fs.writeFileSync('output/playwright/dsh-phase45/ollama-http.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
