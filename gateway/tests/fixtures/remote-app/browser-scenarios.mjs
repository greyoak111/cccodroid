// Browser assertions against the checkout's actual UI. No DOM replacement or fake remote result.
import assert from 'node:assert/strict';
import { LOCAL_SESSION, PRIVATE_SENTINEL } from './original-run.mjs';

const q = JSON.stringify;
export async function runRemoteBrowserScenarios({ cdp, click, fill, until, visible, report, chain, original }) {
  // Factory setup may seed disposable device credentials. Hosting and consent
  // themselves must remain real production GUI/API operations.
  if (chain.prepareBrowser) await chain.prepareBrowser();
  await cdp.eval(`__cc.openSession(${q(LOCAL_SESSION)})`);
  await until(() => cdp.eval(`__cc.view.sessionId===${q(LOCAL_SESSION)} && __cc.view.histOk`), 'original local synthetic session');
  await click('#btn-session-menu');
  await until(() => cdp.eval(visible('.pop-menu')), 'actual current-session menu');
  await cdp.eval("(() => {const b=[...document.querySelectorAll('.pop-menu button')].find(e=>e.innerText.includes('托管到手机'));if(!b)throw new Error('Hosting action absent from actual session menu');b.dataset.remoteAcceptanceEntry='hosting';})()");
  await click('[data-remote-acceptance-entry=hosting]');
  await until(() => cdp.eval(visible('#rs-host-device')), 'real hosting dialog lists paired phone');
  assert.ok(await cdp.eval("!!document.querySelector('#rs-host-device option[value]')"));
  const hostingMetrics = [];
  for (const theme of ['light', 'dark']) for (const font of ['16px', '24px']) {
    await cdp.eval(`Theme.set(${q(theme)});document.documentElement.style.fontSize=${q(font)}`);
    const m = await cdp.eval("(() => {const e=document.querySelector('.rs-overlay .rs-dialog'),r=e.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,overflow:e.scrollWidth-e.clientWidth,buttons:[...e.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({h:b.getBoundingClientRect().height,w:b.getBoundingClientRect().width}))};})()");
    assert.ok(m.left >= -1 && m.right <= m.width + 1 && m.overflow <= 1, `hosting dialog at 360px/${theme}/${font}`);
    assert.ok(m.buttons.every((b) => b.h >= 43 && b.w >= 43), 'hosting touch targets at least 44px');
    hostingMetrics.push({ theme, font, overflow: m.overflow });
  }
  await cdp.eval("document.documentElement.style.fontSize='16px'");
  report('PASS', 'real hosting dialog 360px light/dark large font', JSON.stringify(hostingMetrics));
  const target = chain.phoneDeviceId;
  await click('#rs-host-device');
  await until(() => cdp.eval(visible('.sel-menu')), 'actual phone selection menu opens');
  const option = await cdp.eval(`(()=>{const s=document.querySelector('#rs-host-device');return [...s.options].findIndex(o=>o.value===${q(target)})})()`);
  assert.ok(option > 0, 'the target is a real paired-device option, not the placeholder');
  const optionSelector = '.sel-menu button[data-i="' + option + '"]';
  const pickerLayer = await cdp.eval(`(()=>{const e=document.querySelector(${q(optionSelector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {menuZ:getComputedStyle(e.closest('.sel-menu')).zIndex,overlayZ:getComputedStyle(document.querySelector('.rs-overlay')).zIndex,hit:hit?.className,reachable:e.contains(hit)}})()`);
  assert.equal(pickerLayer.reachable, true, 'the real option must be above the hosting scrim: ' + JSON.stringify(pickerLayer));
  await click(optionSelector);
  await until(() => cdp.eval(`document.querySelector('#rs-host-device').value===${q(target)}&&!document.querySelector('[data-rs=invite]').disabled`), 'actual menu choice enables invitation');
  report('PASS', 'actual hosting device menu is visible and clickable', JSON.stringify(pickerLayer));
  const tap = async (selector) => {
    const point = await until(() => cdp.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e||e.disabled||!e.getClientRects().length)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:false})()`), 'touchable ' + selector);
    await cdp.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const openHostingDialog = async () => {
    await click('#btn-session-menu');
    await until(() => cdp.eval(visible('.pop-menu')), 'session menu after layout change');
    await cdp.eval("(()=>{const b=[...document.querySelectorAll('.pop-menu button')].find(e=>e.innerText.includes('托管到手机'));if(!b)throw Error('Hosting action missing');b.dataset.remoteAcceptanceEntry='hosting';})()");
    await click('[data-remote-acceptance-entry=hosting]');
    await until(() => cdp.eval(visible('#rs-host-device')), 'hosting dialog after layout change');
  };
  const touchMetrics = [];
  for (const size of [{ width: 1280, height: 900 }, { width: 900, height: 480 }, { width: 390, height: 844 }, { width: 660, height: 440 }, { width: 390, height: 844, font: '24px' }]) {
    await click('.rs-dialog-header [data-rs=close]');
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: true });
    await cdp.eval(`document.documentElement.style.fontSize=${q(size.font || '16px')}`);
    // Entering a docked layout legitimately opens the sidebar and closes all
    // overlays; exercise opening hosting at each size, not a synthetic resize race.
    await cdp.eval('new Promise(r=>setTimeout(r,250))');
    await openHostingDialog();
    for (const theme of ['light', 'dark']) {
      await cdp.eval(`Theme.set(${q(theme)})`);
      await tap('#rs-host-device');
      await until(() => cdp.eval(visible('.sel-menu')), 'touch opens device menu');
      await tap('.sel-menu button[data-i="0"]');
      await until(() => cdp.eval("document.querySelector('[data-rs=invite]').disabled"), 'placeholder cannot authorize invitation');
      await tap('#rs-host-device');
      await until(() => cdp.eval(visible('.sel-menu')), 'touch reopens device menu');
      await tap(optionSelector);
      await until(() => cdp.eval(`document.querySelector('#rs-host-device').value===${q(target)}&&!document.querySelector('[data-rs=invite]').disabled`), 'touch choice enables invitation');
      assert.equal(await cdp.eval("!!document.querySelector('.sel-menu')"), false, 'menu closes after selection');
      assert.ok(await cdp.eval(`document.querySelector('#rs-host-fingerprint').textContent.length>0`), 'full paired fingerprint is shown');
      touchMetrics.push({ ...size, theme, nativeTouch: true, placeholderGated: true, pairedPhoneSelected: true });
    }
  }
  await click('.rs-dialog-header [data-rs=close]');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.eval("document.documentElement.style.fontSize='16px';new Promise(r=>setTimeout(r,250))");
  await openHostingDialog();
  await click('#rs-host-device');
  await until(() => cdp.eval(visible('.sel-menu')), 'final device menu');
  await click(optionSelector);
  await cdp.eval("document.querySelector('#rs-host-device').focus({preventScroll:true})");
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => cdp.eval(visible('.sel-menu')), 'keyboard opens device menu');
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => cdp.eval("!document.querySelector('.sel-menu')&&!!document.querySelector('.rs-overlay')"), 'escape closes selection menu without losing hosting modal');
  await click('#rs-host-device'); await click('.sel-menu button[data-i="0"]');
  await cdp.eval("document.querySelector('#rs-host-device').focus({preventScroll:true})");
  const key = async (name, code) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  };
  await key('Enter', 13);
  await until(() => cdp.eval("document.activeElement?.matches('.sel-menu button[data-i=\"0\"]')"), 'keyboard menu owns placeholder focus');
  await key('End', 35);
  assert.equal(await cdp.eval("document.querySelector('#rs-host-device').value"), '', 'moving focus does not select or authorize');
  await key('Enter', 13);
  await until(() => cdp.eval(`document.querySelector('#rs-host-device').value===${q(target)}&&!document.querySelector('[data-rs=invite]').disabled`), 'keyboard explicitly selects paired phone');
  assert.equal(await cdp.eval("document.activeElement?.id"), 'rs-host-device', 'keyboard selection returns focus to original control');
  report('PASS', 'native touch phone selection wide/narrow/split and explicit keyboard selection', JSON.stringify(touchMetrics));
  await click('[data-rs=invite]');
  await until(() => cdp.eval("document.querySelector('.rs-overlay').innerText.includes('等待手机接受')"), 'real invitation result');
  const hosted = await chain.hosted();
  assert.equal(hosted.phoneDeviceId || hosted.deviceId, target);
  assert.equal(hosted.state || hosted.status, 'invited');
  await click('[data-rs=close]');
  if (chain.usePhone) await chain.usePhone();
  await cdp.eval("__cc.openPage('remote')");
  await until(() => cdp.eval(visible('#remotePage [data-rv=accept]')), 'received real invitation visible in real App');
  assert.equal(await cdp.eval(`document.querySelector('#remotePage').innerText.includes(${q(PRIVATE_SENTINEL)})`), false);
  await click('#remotePage [data-rv=accept]');
  // Surface native browser transport failures promptly with their real stack,
  // without injecting bound timers or manufacturing any HTTP result.
  await cdp.eval('window.__cc.remote.transport.status()');
  await until(() => cdp.eval("document.querySelector('#remotePage').innerText.includes('Synthetic original history')"), 'real original history after consent');
  assert.equal(await cdp.eval(`document.querySelector('#remotePage').innerText.includes(${q(PRIVATE_SENTINEL)})`), false);
  report('PASS', 'invite → consent → original history', 'production hosting and remote GUI; only chosen phone/session');
  const run = await original.start();
  await until(() => cdp.eval(visible('#remotePage .rv-request [data-rv=details]')), 'actual original permission card');
  assert.equal(await cdp.eval("document.querySelector('#remotePage [data-rv=approve]').disabled"), true, 'approval gated on full details');
  // Trusted browser insertion must reach the byte limiter before any native
  // maxlength truncation; change/compositionend alone cannot accept the prefix.
  await fill('#remotePage [data-rv-field=draft]', 'a'.repeat(16385));
  const clippedDraft = await cdp.eval(`(()=>{const e=document.querySelector('#remotePage [data-rv-field=draft]');e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return {length:e.value.length,maxlength:e.getAttribute('maxlength'),locked:document.querySelector('#remotePage [data-rv=send]').disabled,notice:document.querySelector('#remotePage').innerText.includes('内容超过远程传输限制')};})()`);
  assert.equal(clippedDraft.length, 16384); assert.equal(clippedDraft.maxlength, null); assert.equal(clippedDraft.locked, true); assert.equal(clippedDraft.notice, true);
  await fill('#remotePage [data-rv-field=draft]', '\nSynthetic draft continuity');
  await cdp.eval(`(()=>{
    const root=document.querySelector('#remotePage'),input=root.querySelector('[data-rv-field=draft]');
    // The oldest record in a bounded live window may legitimately roll out.
    // Select an interior record that the authoritative next snapshot retains.
    const bubble=[...root.querySelectorAll('.bubble')].find(e=>e.textContent==='Synthetic original history 119');
    if(!bubble)throw Error('Retained history record missing before continuity check');
    input.setSelectionRange(4,9,'backward'); input.scrollTop=5;
    const range=document.createRange(); range.selectNodeContents(bubble);
    const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.__remoteContinuity={input,bubble,text:bubble.textContent,anchor:selection.anchorNode,thread:root.querySelector('.rv-thread'),request:root.querySelector('.rv-request')};
  })()`);
  const continuity = { type: 'note', text: 'Synthetic continuity update', runId: run.id, sessionId: LOCAL_SESSION };
  run.log.push(continuity); original.publish(continuity);
  await until(() => cdp.eval("document.querySelector('#remotePage').innerText.includes('Synthetic continuity update')"), 'streamed continuity note');
  const retained = await cdp.eval(`(()=>{const a=window.__remoteContinuity,r=document.querySelector('#remotePage'),input=r.querySelector('[data-rv-field=draft]');return {
    input:input===a.input,thread:r.querySelector('.rv-thread')===a.thread,request:r.querySelector('.rv-request')===a.request,
    bubble:a.bubble.isConnected,range:getSelection().anchorNode===a.anchor&&getSelection().toString()===a.text,
    value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection
  };})()`);
  assert.equal(retained.input, true); assert.equal(retained.thread, true); assert.equal(retained.request, true);
  assert.equal(retained.bubble, true); assert.equal(retained.range, true);
  assert.equal(retained.value, '\nSynthetic draft continuity'); assert.equal(retained.start, 4); assert.equal(retained.end, 9); assert.equal(retained.direction, 'backward');
  await cdp.eval(`(()=>{const e=document.querySelector('#remotePage [data-rv-field=draft]');e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.value='Synthetic composing buffer';e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));})()`);
  const composition = { type: 'note', text: 'Synthetic during composition', runId: run.id, sessionId: LOCAL_SESSION };
  run.log.push(composition); original.publish(composition);
  await until(() => cdp.eval("document.querySelector('#remotePage').innerText.includes('Synthetic during composition')"), 'update during synthetic composition');
  assert.equal(await cdp.eval("document.querySelector('#remotePage [data-rv-field=draft]')===window.__remoteContinuity.input && window.__remoteContinuity.input.value==='Synthetic composing buffer'"), true);
  await cdp.eval("window.__remoteContinuity.input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
  await fill('#remotePage [data-rv-field=draft]', '');
  report('PASS', 'stream update retains actual DOM input, selected text and thread', 'browser node/Range/caret and synthetic composition-event identity; leading LF and oversized ASCII insertion; not a native IME or latency benchmark');
  const publishViewEvent = async (type, text) => {
    const event = { type, text, runId: run.id, sessionId: LOCAL_SESSION };
    run.log.push(event); original.publish(event);
    await cdp.eval('window.__cc.remote.view.refresh()');
  };
  await publishViewEvent('delta', 'Synthetic selected stream abcdef');
  await until(() => cdp.eval("[...document.querySelectorAll('#remotePage .bubble')].some(e=>e.textContent==='Synthetic selected stream abcdef')"), 'actual selected streaming record');
  await cdp.eval(`(()=>{
    const bubble=[...document.querySelectorAll('#remotePage .bubble')].find(e=>e.textContent==='Synthetic selected stream abcdef'),node=bubble.firstChild,start=node.data.indexOf('abcdef')+1;
    const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+3);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    window.__remoteTextRange={bubble,node,start};
  })()`);
  await publishViewEvent('delta', 'g');
  await until(() => cdp.eval("window.__remoteTextRange.bubble.textContent==='Synthetic selected stream abcdefg'"), 'same original record appends delta');
  const appendedRange = await cdp.eval(`(()=>{const a=window.__remoteTextRange,s=getSelection(),r=s.rangeCount?s.getRangeAt(0):null;return {same:a.bubble.isConnected&&a.bubble.firstChild===a.node,text:s.toString(),start:r?.startOffset,end:r?.endOffset,node:r?.startContainer===a.node,expected:a.start};})()`);
  assert.equal(appendedRange.same, true); assert.equal(appendedRange.node, true); assert.equal(appendedRange.text, 'bcd'); assert.equal(appendedRange.start, appendedRange.expected); assert.equal(appendedRange.end, appendedRange.expected + 3);
  await publishViewEvent('note', 'Synthetic retained sibling');
  await cdp.eval(`(()=>{
    const bubble=[...document.querySelectorAll('#remotePage .bubble')].find(e=>e.textContent==='Synthetic retained sibling'),node=bubble.firstChild,range=document.createRange();
    range.setStart(node,1);range.setEnd(node,4);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.__remoteSiblingRange={bubble,node};
  })()`);
  // The original-run display projection removes the partial, not its following
  // system record; this is a source event, not a fabricated phone snapshot/DOM.
  await publishViewEvent('discard_partial', 'Synthetic selected stream abcdefg'.length);
  await until(() => cdp.eval("![...document.querySelectorAll('#remotePage .bubble')].some(e=>e.textContent==='Synthetic selected stream abcdefg')"), 'preceding partial record removed');
  const removedRange = await cdp.eval(`(()=>{const a=window.__remoteSiblingRange,s=getSelection(),r=s.rangeCount?s.getRangeAt(0):null;return {same:a.bubble.isConnected&&a.bubble.firstChild===a.node,text:s.toString(),node:r?.startContainer===a.node,start:r?.startOffset,end:r?.endOffset};})()`);
  assert.equal(removedRange.same, true); assert.equal(removedRange.node, true); assert.equal(removedRange.text, 'ynt'); assert.equal(removedRange.start, 1); assert.equal(removedRange.end, 4);
  report('PASS', 'text-internal Range survives appended delta and preceding record removal', 'real original source events; unchanged selected prefix and sibling retain exact DOM Range offsets');
  await click('#remotePage [data-rv=details]');
  await until(() => cdp.eval(visible('.rv-modal [data-rv=details-read]')), 'complete approval detail modal');
  assert.ok(await cdp.eval("document.querySelector('.rv-modal').innerText.includes('printf remote-fixture-only')"), 'exact original Bash scope is inspectable');
  await click('.rv-modal [data-rv=details-read]');
  await fill('#remotePage [data-rv-field=draft]', '\nPending removal continuity');
  await cdp.eval(`(()=>{
    const input=document.querySelector('#remotePage [data-rv-field=draft]');input.focus({preventScroll:true});input.setSelectionRange(4,9,'backward');
    const state=window.__remotePendingRemoval={input,form:input.closest('form'),blur:0};input.addEventListener('blur',()=>state.blur++);
    // Dispatching the approval click directly keeps the draft as the focused
    // node, isolating patch-induced blur from the normal pointer focus change.
    document.querySelector('#remotePage [data-rv=approve]').click();
  })()`);
  await until(() => cdp.eval("!document.querySelector('#remotePage .rv-pending')"), 'last pending request removed without moving the composer form');
  const pendingRemoval = await cdp.eval(`(()=>{const a=window.__remotePendingRemoval,e=document.querySelector('#remotePage [data-rv-field=draft]');return {same:e===a.input,form:e.closest('form')===a.form,focus:document.activeElement===e,blur:a.blur,value:e.value,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection};})()`);
  assert.equal(pendingRemoval.same, true); assert.equal(pendingRemoval.form, true); assert.equal(pendingRemoval.focus, true); assert.equal(pendingRemoval.blur, 0);
  assert.equal(pendingRemoval.value, '\nPending removal continuity'); assert.equal(pendingRemoval.start, 4); assert.equal(pendingRemoval.end, 9); assert.equal(pendingRemoval.direction, 'backward');
  await fill('#remotePage [data-rv-field=draft]', '');
  await until(() => original.childEvents().then((events) => events.some((event) => event.runId === run.id && event.kind === 'control_response')), 'original child receives real answer');
  await until(() => cdp.eval("document.querySelector('#remotePage').innerText.includes('Original execution continued')"), 'original continuation reaches actual remote UI');
  const controls = (await original.childEvents()).filter((event) => event.runId === run.id && event.kind === 'control_response');
  assert.equal(controls.length, 1); assert.equal(controls[0].response.response.updatedInput.command, 'printf remote-fixture-only');
  report('PASS', 'original approval → original execution continuation', 'complete detail gate; original input preserved; child response once');
  const requestSelector = (id) => '#remotePage [data-request="' + id + '"]';
  const details = async (id, expected) => {
    await until(() => cdp.eval(visible(requestSelector(id) + ' [data-rv=details]')), 'new original request visible ' + id);
    await click(requestSelector(id) + ' [data-rv=details]');
    await until(() => cdp.eval(visible('.rv-modal [data-rv=details-read]')), 'original full detail readable');
    assert.ok(await cdp.eval(`document.querySelector('.rv-modal').innerText.includes(${q(expected)})`));
    // The real modal must retain focus on keyboard traversal and not hide its close path.
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.ok(await cdp.eval("document.querySelector('.rv-modal').contains(document.activeElement)"));
    await click('.rv-modal [data-rv=details-read]');
  };
  const edited = await original.request(run, 'Edit', { file_path: '/synthetic/approval-only.txt', old_string: 'Synthetic before scope', new_string: 'Synthetic after scope' });
  await details(edited.id, 'Synthetic after scope');
  await click(requestSelector(edited.id) + ' [data-rv=deny-toggle]');
  await fill(requestSelector(edited.id) + ' [data-rv-field=reason]', 'r'.repeat(4097));
  const clippedReason = await cdp.eval(`(()=>{const e=document.querySelector(${q(requestSelector(edited.id) + ' [data-rv-field=reason]')});return {length:e.value.length,maxlength:e.getAttribute('maxlength'),notice:document.querySelector('#remotePage').innerText.includes('内容超过远程传输限制')};})()`);
  assert.equal(clippedReason.length, 4096); assert.equal(clippedReason.maxlength, null); assert.equal(clippedReason.notice, true);
  await click(requestSelector(edited.id) + ' [data-rv=deny]');
  assert.equal((await original.childEvents()).some(e => e.kind === 'control_response' && e.response.request_id === edited.id), false, 'a clipped denial reason cannot be submitted');
  await fill(requestSelector(edited.id) + ' [data-rv-field=reason]', '\nSynthetic GUI denial reason');
  await publishViewEvent('note', 'Synthetic leading LF reason update');
  assert.equal(await cdp.eval(`document.querySelector(${q(requestSelector(edited.id) + ' [data-rv-field=reason]')}).value`), '\nSynthetic GUI denial reason');
  await click(requestSelector(edited.id) + ' [data-rv=deny]');
  await until(() => original.childEvents().then((events) => events.some((e) => e.kind === 'control_response' && e.response.request_id === edited.id)), 'GUI Edit denial returns to actual child');
  const denied = (await original.childEvents()).find((e) => e.kind === 'control_response' && e.response.request_id === edited.id).response.response;
  assert.equal(denied.behavior, 'deny'); assert.equal(denied.message, 'Synthetic GUI denial reason');
  const question = await original.request(run, 'AskUserQuestion', { questions: [{ question: 'Synthetic browser question', header: 'Fixture', multiSelect: false, options: [{ label: 'First', description: 'Synthetic option one' }, { label: 'Second', description: 'Synthetic option two' }] }] });
  await details(question.id, 'Synthetic browser question');
  await fill(requestSelector(question.id) + ' [data-rv-field=answer]', 'a'.repeat(16385));
  const clippedAnswer = await cdp.eval(`(()=>{const e=document.querySelector(${q(requestSelector(question.id) + ' [data-rv-field=answer]')});return {length:e.value.length,maxlength:e.getAttribute('maxlength'),locked:document.querySelector(${q(requestSelector(question.id) + ' [data-rv=approve]')}).disabled};})()`);
  assert.equal(clippedAnswer.length, 16384); assert.equal(clippedAnswer.maxlength, null); assert.equal(clippedAnswer.locked, true);
  assert.equal((await original.childEvents()).some(e => e.kind === 'control_response' && e.response.request_id === question.id), false);
  await fill(requestSelector(question.id) + ' [data-rv-field=answer]', '\nSynthetic browser free answer');
  await publishViewEvent('note', 'Synthetic leading LF answer update');
  assert.equal(await cdp.eval(`document.querySelector(${q(requestSelector(question.id) + ' [data-rv-field=answer]')}).value`), '\nSynthetic browser free answer');
  await click(requestSelector(question.id) + ' [data-rv=approve]');
  await until(() => original.childEvents().then((events) => events.some((e) => e.kind === 'control_response' && e.response.request_id === question.id)), 'GUI free answer returns to original run');
  const answered = (await original.childEvents()).find((e) => e.kind === 'control_response' && e.response.request_id === question.id).response.response;
  assert.equal(answered.updatedInput.answers['Synthetic browser question'], 'Synthetic browser free answer');
  const plan = await original.request(run, 'ExitPlanMode', { plan: 'Synthetic browser plan: inspect, then ask before each write.' });
  await details(plan.id, 'ask before each write');
  await click(requestSelector(plan.id) + ' [data-rv=approve]');
  await until(() => original.childEvents().then((events) => events.some((e) => e.kind === 'control_response' && e.response.request_id === plan.id)), 'GUI plan answer returns to actual child');
  const planResponse = (await original.childEvents()).find((e) => e.kind === 'control_response' && e.response.request_id === plan.id).response.response;
  assert.equal(planResponse.behavior, 'allow'); assert.equal(Object.hasOwn(planResponse, 'updatedPermissions'), false);
  report('PASS', 'real Edit denial/question/plan GUI and focus', 'complete scope, exact denial/free answer, no permanent grant, actual original child receipts');
  const measurements = [];
  for (const width of [360, 600]) for (const theme of ['light', 'dark']) for (const font of ['16px', '24px']) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`Theme.set(${q(theme)});document.documentElement.style.fontSize=${q(font)}`);
    const m = await cdp.eval(`(() => {const e=document.querySelector('#remotePage'),r=e.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,overflow:document.documentElement.scrollWidth-innerWidth,localOverflow:e.scrollWidth-e.clientWidth,buttons:[...e.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({h:b.getBoundingClientRect().height,w:b.getBoundingClientRect().width}))};})()`);
    assert.ok(m.left >= -1 && m.right <= m.width + 1, `remote container ${width}/${theme}/${font}`);
    assert.ok(m.overflow <= 1 && m.localOverflow <= 1, `no horizontal page overflow ${width}/${theme}/${font}`);
    assert.ok(m.buttons.every((b) => b.h >= 43 && b.w >= 43), 'minimum touch targets');
    measurements.push({ width, theme, font, overflow: m.overflow });
  }
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.eval("document.documentElement.style.fontSize='16px'");
  report('PASS', 'real remote 360px/split-screen light/dark large font', JSON.stringify(measurements));
  const text = 'Synthetic phone message delivered exactly once';
  await fill('#remotePage [data-rv-field=draft]', text); await click('#remotePage [data-rv=send]');
  await until(() => original.QUEUE.some((item) => item.message === text && item.sessionId === LOCAL_SESSION), 'phone message in actual busy original queue');
  assert.equal(original.QUEUE.filter((item) => item.message === text).length, 1);
  await original.signal(run.id, { kind: 'finish' });
  await until(() => original.childEvents().then((events) => events.filter((event) => event.kind === 'user' && JSON.stringify(event.message).includes(text)).length === 1), 'one real child receives phone text');
  await until(() => cdp.eval("document.querySelector('#remotePage').innerText.includes('已进入原会话')"), 'tablet-issued original message receipt shown');
  report('PASS', 'phone text → original session once', 'busy queue retained; no local /api/chat; true original replay receipt');
  await until(async () => { const runId = original.runOfSession(LOCAL_SESSION)?.id; return runId && await cdp.eval(`window.__cc.remote.transport.status().then(s=>s.binding?.runId===${q(runId)} && s.canControl)`); }, 'browser current original run binding before stop');
  await click('#remotePage [data-rv=stop]'); await click('.rv-modal [data-rv=stop-confirm]');
  await until(() => cdp.eval("[...document.querySelectorAll('#remotePage .rv-receipt')].some(e=>e.innerText.includes('平板已确认：当前执行已停止') || e.innerText.includes('平板已确认：原运行已结束'))"), 'real original child stop receipt visible');
  await until(() => original.runOfSession(LOCAL_SESSION) === null, 'browser stop has ended exact original child');
  report('PASS', 'stop original run with true receipt', 'not server-received or optimistic button state');
  if (chain.revoke) {
    const next = await original.start();
    await chain.revoke();
    await until(() => cdp.eval("document.querySelector('#remotePage').innerText.includes('收回')"), 'revocation clears actual phone page');
    assert.ok(original.RUNS.has(next.id), 'revocation cannot stop original task');
    assert.equal(await cdp.eval("!!document.querySelector('#remotePage [data-rv-field=draft]:not(:disabled)')"), false);
    report('PASS', 'revoke access but keep original task', 'phone content/control disabled; actual original run stays alive');
  } else report('SKIP', 'runtime revoke browser case', 'factory has not exposed host-side revoke control');
}
