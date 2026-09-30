// Existing Playwright MCP filename entry; synthetic IPC only, never load in production.
async (page) => {
  const bootstrap = `
    import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
    mockWindows('main');
    const listeners=new Map();
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    window.__FIXTURE__={offline:false,noModels:false,modelError:false,parseError:false,paths:[],parseDelay:300};
    window.__COMMANDS__=[];window.__REQUESTS__=[];
    const models=['fixture-small:1b','fixture-reasoner:2b','fixture-code:3b','fixture-4:1b','fixture-5:1b','fixture-with-a-very-long-local-model-name-that-must-fit:7b'];
    const settings={theme:'system',saveThinking:false,defaultMode:'fast',defaultModel:models[0],modelAliases:{'fixture-code:3b':'代码助手','fixture-with-a-very-long-local-model-name-that-must-fit:7b':'一个很长的本地模型别名，用于确认窄窗中的发送按钮仍可使用'},contextSize:4096,outputTokenLimit:2048,reasoningTokenLimit:2048};
    const conversation={id:'history',title:'合成历史',model:models[0],modelAlias:'',mode:'fast',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',messageCount:2};
    window.__emit=(payload)=>{for(const handler of listeners.get('chat:chunk')||[]){if(window.__TAURI_INTERNALS__.callbacks.has(handler)) window.__TAURI_INTERNALS__.runCallback(handler,{event:'chat:chunk',payload});}};
    mockIPC(async(cmd,args)=>{
      window.__COMMANDS__.push({cmd,args});
      switch(cmd){
        case 'plugin:event|listen': {const list=listeners.get(args.event)||[];list.push(args.handler);listeners.set(args.event,list);return args.handler;}
        case 'plugin:event|unlisten': {listeners.set(args.event,(listeners.get(args.event)||[]).filter(id=>id!==args.eventId));return;}
        case 'plugin:window|is_maximized': return false;
        case 'get_service_status': if(window.__FIXTURE__.offline) throw new Error('合成服务离线'); return {version:'fixture'};
        case 'get_models': await delay(120); if(window.__FIXTURE__.modelError) throw new Error('合成模型目录错误'); return {models:window.__FIXTURE__.noModels?[]:models.map(name=>({name}))};
        case 'get_settings': await delay(180);return settings;
        case 'list_conversations': return [conversation];
        case 'get_conversation': await delay(400); return {conversation,attachments:[],messages:[{id:'u',conversationId:'history',role:'user',content:'历史问题',status:'done',createdAt:conversation.createdAt,attachments:[]},{id:'a',conversationId:'history',role:'assistant',content:'合成历史回答。'.repeat(500),thinking:'',status:'done',createdAt:conversation.createdAt,attachments:[]}]};
        case 'create_conversation_with_message': await delay(100);return {conversation:{...conversation,id:args.id,title:'阶段三生成',model:args.model},messages:[],attachments:[]};
        case 'start_chat': window.__REQUESTS__.push(args);return;
        case 'stop_chat': window.__emit({request_id:args.requestId,content:'',thinking:'',cancelled:true,done:false});return true;
        case 'save_message': case 'save_conversation_attachments': case 'release_local_attachments': return;
        case 'plugin:dialog|open': return window.__FIXTURE__.paths;
        case 'parse_local_attachments': await delay(window.__FIXTURE__.parseDelay);if(window.__FIXTURE__.parseError) throw new Error('合成附件解析失败');return args.paths.map((path,index)=>({id:'file-'+index+'-'+Date.now(),name:path.split('/').pop(),kind:'PDF',sizeBytes:2048,textCharacters:800,chunkCount:2,pageCount:1,sheets:[],warnings:index===0?['合成解析提示']:[]}));
        default: throw new Error('Unmocked fixture command: '+cmd);
      }
    });
    await import('/src/main.tsx');
  `;
  await page.unrouteAll({behavior:'wait'});
  await page.route('http://127.0.0.1:1420/',async route=>{
    const response=await route.fetch();const html=await response.text();
    const body=html.replace(/<script type="module" src="\/src\/main\.tsx(?:\?[^\"]*)?"><\/script>/,'<script type="module">'+bootstrap+'</script>');
    if(body===html)throw new Error('Fixture interception failed');await route.fulfill({response,body});
  });
  await page.goto('http://127.0.0.1:1420/');
  await page.locator('.workspace-hero').waitFor();
  const geometry=[];
  for(const theme of ['light','dark']){
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    for(const [width,height] of [[860,640],[1024,820],[1180,820],[1440,900]]){
      await page.setViewportSize({width,height});
      await page.screenshot({path:'D:/ollmin/output/playwright/dsh-phase3/hero-'+theme+'-'+width+'.png'});
      geometry.push(await page.evaluate(()=>{const panel=document.querySelector('.conversation-panel').getBoundingClientRect(),heading=document.querySelector('.hero-heading').getBoundingClientRect(),input=document.querySelector('.composer').getBoundingClientRect();return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,radius:getComputedStyle(document.querySelector('.composer')).borderRadius,textareaHeight:document.querySelector('textarea').getBoundingClientRect().height,centerDelta:(heading.top+input.bottom)/2-(panel.top+panel.bottom)/2,overflow:document.documentElement.scrollWidth>innerWidth};}));
    }
  }
  for(const item of geometry)if(item.radius!=='28px'||item.textareaHeight<52||item.overflow||Math.abs(item.centerDelta)>30)throw new Error('Hero geometry: '+JSON.stringify(item));
  await page.setViewportSize({width:1180,height:820});
  return {geometry};
}
