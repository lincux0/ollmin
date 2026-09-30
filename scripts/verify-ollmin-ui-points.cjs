// Run with the existing MCP after capture-ollmin-phase45.cjs.
async page => {
  const checks=[];const check=(ok,label)=>{if(!ok)throw new Error(label);checks.push(label);};
  await page.setViewportSize({width:1180,height:820});await page.reload();await page.locator('.session-main').waitFor();
  const style=selector=>page.locator(selector).first().evaluate(el=>({radius:getComputedStyle(el).borderRadius,height:el.getBoundingClientRect().height}));
  check(await page.locator('.sidebar').evaluate(el=>getComputedStyle(el).paddingTop==='24px'&&getComputedStyle(el).paddingBottom==='24px'&&getComputedStyle(el).paddingLeft==='20px'),'侧栏上下24左右20px');
  const trigger=page.getByRole('button',{name:'搜索会话',exact:true});await trigger.click();
  const search=page.getByRole('textbox',{name:'搜索本地会话'});await search.waitFor();
  check(await page.locator('.sidebar .new-chat-button').count()===0&&!await page.locator('.sidebar').getByText('本地会话',{exact:true}).count()&&await trigger.evaluate(el=>el.previousElementSibling?.getAttribute('aria-label')==='新建对话'),'顶部新建右侧搜索与侧栏精简');
  await search.fill('临时查询');await page.locator('.hero-heading h1').click();await search.waitFor({state:'detached'});await trigger.click();await search.waitFor();check(await search.inputValue()==='','外部点击收起并清空搜索');
  await search.press('Escape');await trigger.waitFor();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='搜索会话');checks.push('搜索Escape返回入口');
  await page.locator('.session-main').first().click();await page.locator('.workspace-active').waitFor();
  check(await page.locator('.conversation-header').evaluate(el=>el.querySelector('h2').textContent==='合成历史'&&!el.querySelector('.section-kicker')&&getComputedStyle(el.querySelector('h2')).fontSize==='22px'),'仅显示22px会话标题');
  check(await page.locator('.composer-toolbar-left').getByRole('button').count()===1&&await page.locator('.model-picker-chevron').count()===0,'去掉重复模式入口与模型箭头');
  check((await style('.session-item')).radius==='9px'&&(await style('.session-main')).radius==='9px','会话卡片统一9px');
  for(const selector of ['.context-size','.header-button']){const item=await style(selector);check(item.radius==='999px'&&item.height<=30,'扁圆头部控件 '+selector);}
  const handle=page.getByRole('separator',{name:'正文宽度'});await handle.hover();check(await handle.evaluate(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'),'正文拖宽无悬浮提示线');
  await page.locator('.model-picker-trigger').click();check((await style('.menu-surface')).radius==='9px'&&(await style('.menu-surface button')).radius==='9px'&&await page.locator('.menu-surface').evaluate(el=>el.getBoundingClientRect().width===280),'模型菜单9px与280px窄宽');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'模型与性能',exact:true}).click();
  check(await page.locator('.settings-dialog-disclosure').evaluate(el=>getComputedStyle(el).alignItems==='center'),'模型别名文字图标居中');
  check(await page.locator('.settings-dialog-disclosure').evaluate(el=>getComputedStyle(el).fontSize==='13px'&&getComputedStyle(el).fontWeight==='600'),'别名按钮13px常规字重');
  await page.getByRole('button',{name:'会话与隐私',exact:true}).click();check(await page.locator('.settings-dialog-danger').evaluate(el=>getComputedStyle(el).fontSize==='13px'&&getComputedStyle(el).fontWeight==='600'),'清空按钮13px常规字重');
  await page.getByRole('button',{name:'本机服务与关于',exact:true}).click();
  check(await page.locator('.settings-dialog-actions').evaluate(el=>el.getBoundingClientRect().top-el.previousElementSibling.getBoundingClientRect().bottom>=12),'服务操作距横线12px');
  await page.screenshot({path:'D:/ollmin/output/playwright/dsh-phase45/ui-points-service.png'});await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await page.keyboard.press('Control+n');await page.locator('.workspace-hero').waitFor();
  const input=page.getByRole('textbox',{name:'输入消息',exact:true});
  for(const question of ['一二三四五六七八九十十一十二','短问题']){
    const requestCount=await page.evaluate(()=>window.__REQUESTS__.length);
    await input.fill(question);await input.press('Enter');await page.getByRole('button',{name:'停止生成',exact:true}).waitFor();
    await page.waitForFunction(count=>window.__REQUESTS__.length>count,requestCount);
    await page.evaluate(()=>window.__emit({request_id:window.__REQUESTS__.at(-1).requestId,content:'合成回答',thinking:'',done:true}));await page.getByRole('button',{name:'发送',exact:true}).waitFor();
  }
  await page.locator('.turn-navigator-item').first().hover();const tip=page.getByRole('tooltip');await tip.waitFor();
  check(await tip.innerText()==='一二三四五六七八九十……','导航仅前10字加省略');
  check(await tip.evaluate(el=>getComputedStyle(el).whiteSpace==='nowrap'&&el.getBoundingClientRect().width>el.getBoundingClientRect().height),'导航横向单行');
  await page.screenshot({path:'D:/ollmin/output/playwright/dsh-phase45/ui-points-history.png'});
  return {checks,count:checks.length,scope:'Synthetic IPC; no user database edits'};
}
