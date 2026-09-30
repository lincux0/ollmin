// Playwright MCP browser_run_code_unsafe filename entry. Test-only IPC; production entry is untouched.
async (page) => {
  const phase = page.__capturePhase || 'dsh-phase0';
  if (!/^dsh-phase[012]$/.test(phase)) throw new Error('Invalid capture phase');
  const bootstrap = `
    import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
    import { emit } from '/node_modules/@tauri-apps/api/event.js';
    mockWindows('main');
    let maximized = false;
    window.__UI_COMMANDS__ = [];
    window.__UI_QUERIES__ = []; window.__SEARCH_FAIL__ = false;
    const settings = {theme:'system',saveThinking:false,defaultMode:'fast',defaultModel:'fixture-small:1b',modelAliases:{},contextSize:4096,outputTokenLimit:2048,reasoningTokenLimit:2048};
    const conversation = {id:'fixture',title:'合成会话 · UI 基线',model:'fixture-small:1b',modelAlias:'',mode:'fast',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',messageCount:2};
    mockIPC((cmd,args) => {
      window.__UI_COMMANDS__.push(cmd);
      switch(cmd) {
        case 'get_service_status': return {version:'fixture'};
        case 'get_models': return {models:[{name:'fixture-small:1b'}]};
        case 'get_settings': return settings;
        case 'list_conversations':
          window.__UI_QUERIES__.push(args.query);
          if (window.__SEARCH_FAIL__) throw new Error('合成数据库搜索失败');
          if (args.query === 'slow') return new Promise(resolve=>setTimeout(()=>resolve([{...conversation,id:'slow',title:'过期结果'}]),600));
          if (args.query === 'fast') return [{...conversation,id:'fast',title:'最新结果'}];
          if (args.query === 'none') return [];
          return [conversation];
        case 'rename_conversation': if(window.__ACTION_FAIL__) throw new Error('合成重命名失败'); conversation.title=args.title; return;
        case 'delete_conversation': case 'clear_conversations': return;
        case 'export_conversation': return {format:args.format,filename:'fixture.'+(args.format==='json'?'json':'md'),content:'合成导出'};
        case 'get_conversation': return {conversation,attachments:[],messages:[
          {id:'u',conversationId:'fixture',role:'user',content:'你好，请解释本地小模型。',status:'done',createdAt:conversation.createdAt,attachments:[]},
          {id:'a',conversationId:'fixture',role:'assistant',content:'本地模型在设备上运行。\\n\\n- 保留本地数据\\n- 限制上下文预算',thinking:'这是一条合成思考。',status:'done',createdAt:conversation.createdAt,attachments:[]}
        ]};
        case 'plugin:window|is_maximized': return maximized;
        case 'plugin:window|toggle_maximize': maximized=!maximized; setTimeout(()=>emit('tauri://resize',{width:1180,height:820}),0); return;
        case 'plugin:window|minimize': case 'plugin:window|close': case 'plugin:window|start_dragging': return;
        default: throw new Error('Unmocked command: '+cmd);
      }
    }, {shouldMockEvents:true});
    await import('/src/main.tsx');
  `;
  await page.unrouteAll({behavior:'wait'});
  let resetPreferences = phase === 'dsh-phase2';
  await page.route('http://127.0.0.1:1420/', async route => {
    const response=await route.fetch();
    const original = await response.text();
    const body=original.replace(/<script type="module" src="\/src\/main\.tsx(?:\?[^\"]*)?"><\/script>/, '<script type="module">'+(resetPreferences ? 'localStorage.clear();' : '')+bootstrap+'</script>');
    if (body === original) throw new Error('Test entry interception failed');
    resetPreferences = false;
    await route.fulfill({response,body});
  });
  await page.goto('http://127.0.0.1:1420/');
  await page.getByText('Ollama fixture', {exact:true}).waitFor();
  const results=[];
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    // Stage 0 predates the system change listener; set the same resolved theme explicitly.
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    for (const [width,height] of [[860,640],...(phase === 'dsh-phase2' ? [[1024,820]] : []),[1180,820],[1440,900]]) {
      await page.setViewportSize({width,height});
      await page.screenshot({path:'D:/ollmin/output/playwright/'+phase+'/fixture-'+theme+'-'+width+'.png'});
      results.push(await page.evaluate(()=>({theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,titlebar:document.querySelector('.window-bar').getBoundingClientRect().height,sidebar:document.querySelector('.sidebar').getBoundingClientRect().width,mainRadius:getComputedStyle(document.querySelector('.conversation-panel')).borderTopLeftRadius,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,canvas:getComputedStyle(document.querySelector('.conversation-panel')).backgroundColor})));
    }
  }
  await page.setViewportSize({width:1180,height:820});
  await page.locator('.session-main').filter({hasText:'合成会话 · UI 基线'}).click();
  await page.getByText('你好，请解释本地小模型。', {exact:true}).waitFor();
  await page.screenshot({path:'D:/ollmin/output/playwright/'+phase+'/fixture-history.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.screenshot({path:'D:/ollmin/output/playwright/'+phase+'/fixture-settings.png'});
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  if (phase === 'dsh-phase2') {
    for (const result of results) {
      if (result.titlebar !== 40 || result.sidebar !== (result.width < 1024 ? 0 : 280) || result.mainRadius !== '16px' || result.horizontalOverflow) throw new Error('Phase 2 geometry regression: '+JSON.stringify(result));
    }
  }
  if (phase === 'dsh-phase1') {
    for (const result of results) {
      if (result.titlebar !== 40 || result.sidebar !== 280 || result.mainRadius !== '16px' || result.horizontalOverflow) throw new Error('Phase 1 geometry regression: '+JSON.stringify(result));
      if (result.canvas !== (result.theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(21, 21, 23)')) throw new Error('Phase 1 canvas token regression');
    }
    for (const theme of ['light','dark']) {
      await page.emulateMedia({colorScheme:theme});
      await page.waitForFunction(t=>document.documentElement.dataset.theme===t, theme);
    }
    await page.getByRole('button',{name:'最大化',exact:true}).click();
    await page.getByRole('button',{name:'还原',exact:true}).waitFor();
    await page.getByRole('button',{name:'还原',exact:true}).click();
    await page.getByRole('button',{name:'最大化',exact:true}).waitFor();
    await page.locator('.window-drag-region').dispatchEvent('mousedown',{button:0});
    await page.getByRole('button',{name:'最小化',exact:true}).click();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    const commands=await page.evaluate(()=>window.__UI_COMMANDS__);
    for (const cmd of ['plugin:window|toggle_maximize','plugin:window|start_dragging','plugin:window|minimize','plugin:window|close']) {
      if (!commands.includes(cmd)) throw new Error('Missing window action: '+cmd);
    }
    if (commands.includes('start_chat')) throw new Error('Shell validation submitted a chat');
  }
  return {phase,results,commands:await page.evaluate(()=>window.__UI_COMMANDS__)};
}
