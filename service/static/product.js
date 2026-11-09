'use strict';
const $ = id => document.getElementById(id);
// A stylesheet failure must not leave a permanently unstyled application.
function recoverStyles() {
  const link=$('productStyles'),warning=$('assetError');let retried=false;
  const failed=()=>{
    if(retried){warning.hidden=false;return;}
    retried=true;const url=new URL(link.href);url.searchParams.set('retry','1');link.href=url.href;
  };
  link.addEventListener('error',failed);
  link.addEventListener('load',()=>{warning.hidden=true;});
  $('reloadAssets').onclick=()=>location.reload();
  // Deferred scripts run after the initial blocking stylesheet has settled.
  if(!link.sheet)failed();
}
recoverStyles();
const element = (tag, text, className) => {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
};
const scrollBehavior = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const clean = value => String(value ?? '').replace(/【[^】]*】/g, '').replace(/\\n/g, '\n');
const statusLabel = value => ({PASS: '일치', FAIL: '불일치', REQUIRES_HUMAN_REVIEW: '검토 필요'}[value] || '확인 필요');
const statusTone = value => ({PASS: 'pass', FAIL: 'fail', REQUIRES_HUMAN_REVIEW: 'review'}[value] || 'pending');
const phaseLabel = {uploading:'문서 전송 중', creating_job:'검증 요청 중', queued:'검증 대기 중', in_progress:'문서 분석·비교 중', retrieving:'결과 조회 중', completed:'검증 완료', failed:'실행 오류', paused:'조회 중단', creation_unknown:'요청 상태 확인 필요', upload_unknown:'전송 상태 확인 필요', error:'연결 확인 필요', incomplete:'미완료', cancelled:'취소됨', canceled:'취소됨'};
const activePhases = new Set(['uploading', 'creating_job', 'queued', 'in_progress', 'retrieving']);
const documentLabel = {PO:'발주서', CI:'상업송장', PL:'포장명세서', BL:'선하증권(B/L)'};
let connection = {}, pickedFile = null, currentRow = null, currentSource = null;
let routeToken = 0, submitting = false, clock = null, checkFilter = 'attention';
let reviewFilter='all',renderedReviewCheck=null;
let guidedReview=false,guidedScrollY=0,guidedReturnFocus=null;
let historyRows=[];
function setReadingSize(large) {
  document.documentElement.classList.toggle('large-text',large);
  $('readingToggle').setAttribute('aria-pressed',String(large));
  $('readingToggle').setAttribute('aria-label',large?'글씨를 크게 보고 있어요. 기본 크기로 바꾸기':'글씨 크게 보기');
}
try { setReadingSize(localStorage.getItem('tradematch.large-text')==='1'); } catch { setReadingSize(false); }
$('readingToggle').addEventListener('click',()=>{
  const large=!document.documentElement.classList.contains('large-text');setReadingSize(large);
  try { localStorage.setItem('tradematch.large-text',large?'1':'0'); } catch {}
  requestAnimationFrame(()=>{updateReasonToggle();scheduleComparisonLines();});
});
document.querySelector('.skip-link').addEventListener('click',event=>{
  event.preventDefault();$('mainContent').focus({preventScroll:true});$('mainContent').scrollIntoView({behavior:'auto',block:'start'});
});
const waitingResults = new Set();
try {
  const saved=JSON.parse(sessionStorage.getItem('tradematch.waiting-results')||'[]');
  if(Array.isArray(saved))for(const id of saved.slice(-10))if(/^[a-f0-9]{32}$/.test(id))waitingResults.add(id);
} catch {}
function rememberWaiting(id, waiting=true) {
  if(waiting===waitingResults.has(id))return;
  if(waiting)waitingResults.add(id);else waitingResults.delete(id);
  try { sessionStorage.setItem('tradematch.waiting-results',JSON.stringify([...waitingResults].slice(-10))); } catch {}
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let value;
  try { value = await response.json(); }
  catch { throw new Error('서비스 응답을 확인하지 못했습니다. 검증 기록에서 작업 상태를 확인하세요.'); }
  if (!response.ok) throw new Error(value.error || '요청을 처리하지 못했습니다.');
  return value;
}
const post = (path, value = {}) => api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)});
function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function showPage(id) {
  if(guidedReview)closeGuidedReview(false);
  closeReport(false);
  if($('workflowDialog').open)closeWorkflow(false);
  if(id!=='progressView'&&id!=='gameView')hoopGame.pause();
  for (const page of document.querySelectorAll('.page')) page.hidden = page.id !== id;
}
function paintJourney(host,stage,state,caption='') {
  const journey=$('serviceJourney'),target=$(host);
  if(journey.parentElement!==target)target.append(journey);
  journey.dataset.state=state;journey.dataset.stage=String(stage);
  const captions=[stage>0?'문서를 등록했어요':state==='sending'?'PDF를 보내고 있어요':state==='selected'?'파일이 준비됐어요':'PDF를 골라주세요',stage>1?'비교를 마쳤어요':stage===1?caption:'등록 후 시작해요',stage===2?(state==='viewing'?'지금 보고 있어요':'결과가 준비됐어요'):'완료되면 볼 수 있어요'];
  [...journey.children].forEach((item,index)=>{
    item.classList.toggle('is-done',index<stage||(stage===2&&state==='viewing'));
    item.classList.toggle('is-current',index===stage);
    if(index===stage)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');
    const label=item.querySelector('.journey-caption');if(label.textContent!==captions[index])label.textContent=captions[index];
  });
}
function navigate(url, {replace = false} = {}) {
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin) return;
  if (target.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', target.pathname + target.search);
  renderRoute();
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-route]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (submitting) { notice('문서를 올리고 있어요. 잠시만 기다려주세요.'); return; }
  const requestedResult=new URL(link.href,location.origin).searchParams.get('run');
  if(requestedResult)rememberWaiting(requestedResult,false); // Opening a history record is an explicit result request.
  navigate(link.href);
});
window.addEventListener('popstate', renderRoute);
function stopClock() { clearInterval(clock); clock = null; }
function startClock(row) {
  stopClock();
  const started = Date.parse(row.created_at);
  const paint = () => {
    if (!Number.isFinite(started)) { $('elapsed').textContent = ''; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    $('elapsed').textContent = '접수 후 ' + (seconds >= 60 ? Math.floor(seconds / 60) + '분 ' : '') + (seconds % 60) + '초';
  };
  paint(); clock = setInterval(paint, 1000);
}
async function renderRoute() {
  const token = ++routeToken;
  stopClock(); hoopGame.pause(); notice();
  const params = new URLSearchParams(location.search), id = params.get('run'), view = params.get('view');
  const isHistory = !id && view === 'history', isAbout = !id && !['new','history','game'].includes(view), isNew = !id && ['new','game'].includes(view);
  document.title=(id?'검증 조회':isHistory?'검증 기록':isAbout?'서비스 소개':view==='game'?'PDF 자유투':'새 검증')+' · TradeMatch';
  $('navAbout').classList.toggle('active', isAbout);
  $('navAbout').setAttribute('aria-current', isAbout ? 'page' : 'false');
  $('navNew').classList.toggle('active', isNew);
  $('navHistory').classList.toggle('active', Boolean(id) || isHistory);
  $('navNew').setAttribute('aria-current', isNew ? 'page' : 'false');
  $('navHistory').setAttribute('aria-current', id || isHistory ? 'page' : 'false');
  window.scrollTo(0, 0);
  if (id) {
    showPage('progressView');
    $('progressHeading').textContent = '검증 기록을 불러오고 있습니다.';
    $('progressFilename').textContent = ''; $('progressMessage').textContent = ''; $('elapsed').textContent = '';
    if($('serviceJourney').parentElement===$('progressJourneyHost'))$('newJourneyHost').append($('serviceJourney'));
    $('processVisual').dataset.phase='loading';$('processVisualLabel').textContent='기록을 불러오고 있어요';
    $('resultReady').hidden=true;$('viewResult').disabled=false;$('timeEstimate').hidden=false;
    if (!/^[a-f0-9]{32}$/.test(id)) { renderError(null, '올바른 검증 기록 주소가 아닙니다.'); return; }
    try { await monitor(id, token); }
    catch (error) { if (token === routeToken) renderError(currentRow?.id === id ? currentRow : null, error.message); }
  } else if (isAbout) {
    showPage('aboutView'); $('aboutHeading').focus({preventScroll:true});
  } else if (params.get('view')==='game') {
    showPage('gameView');mountHoopGame('practice','standaloneGameHost');
  } else if (isHistory) {
    showPage('historyView'); $('historyHeading').focus({preventScroll:true});
    try { await refreshHistory(token); } catch (error) { if (token === routeToken) notice(error.message); }
  } else {
    showPage('newView'); updateFile(); $('newHeading').focus({preventScroll:true}); if(connection.can_execute)paintTimeEstimate({settings_snapshot:connection.settings,job_id:null},token);
  }
}
$('aboutShowWorkflow').addEventListener('click', () => {
  $('aboutWorkflowHeading').focus({preventScroll:true});
  $('aboutWorkflowHeading').scrollIntoView({behavior:scrollBehavior(),block:'start'});
});
function updateConnection() {
  const ready = Boolean(connection.can_execute);
  $('connectionDot').classList.toggle('connected', ready);
  for(const link of document.querySelectorAll('a[href="/workspace"]'))link.hidden=Boolean(connection.settings_locked);
  const connectionLabel=connection.settings_locked?'검증 환경':'연결 설정';$('connectionLabel').textContent=connectionLabel;
  $('connectOpen').setAttribute('aria-label', connectionLabel+(ready?', 검증 환경 준비됨':', 준비 필요'));
  $('setupNeeded').hidden = ready || !connection.settings;
  $('setupMessage').textContent = connection.key_available ? '사용할 Studio 워크플로우를 연결해 주세요.' : '연결 설정에서 API 키 준비 방법과 사용할 워크플로우를 확인해 주세요.';
  updateFile();
}
async function refreshConnection() {
  connection = await api('/api/connection'); updateConnection();
}
function updateFile() {
  $('newView').dataset.fileState=submitting?'sending':pickedFile?'selected':'empty';
  if(!$('newView').hidden)paintJourney('newJourneyHost',0,submitting?'sending':pickedFile?'selected':'idle');
  $('dropzone').hidden = Boolean(pickedFile);
  $('selectedFile').hidden = !pickedFile;
  if (pickedFile) {
    $('selectedName').textContent = pickedFile.name;
    $('selectedSize').textContent = pickedFile.size < 1024 * 1024 ? (pickedFile.size / 1024).toFixed(0) + ' KB' : (pickedFile.size / 1024 / 1024).toFixed(2) + ' MB';
  }
  $('liveStart').disabled = !pickedFile || submitting || !connection.settings;
  $('liveStart').textContent = submitting ? '문서 접수 중…' : connection.can_execute ? '검증 시작 →' : '연결 설정 후 검증 →';
  $('uploadHint').textContent = submitting ? '문서가 잘 접수됐는지 확인하고 있어요.' : !pickedFile ? '파일을 고른 뒤 검증 시작을 눌러주세요.' : !connection.can_execute ? '파일이 준비됐어요. 연결 설정을 마치면 검증할 수 있어요.' : '검증 시작을 누르면 Studio로 보내 문서를 비교해요.';
  $('removeFile').disabled = submitting; $('changeFile').disabled=submitting; $('uploadEstimate').hidden=!connection.can_execute;
}
function chooseFile(file) {
  if (!file || submitting) return;
  if (!file.name.toLowerCase().endsWith('.pdf') || !file.size || file.size > 50 * 1024 * 1024) {
    $('productFile').value='';notice('50 MB 이하의 PDF 한 개를 골라주세요. 빈 파일은 올릴 수 없어요.'+(pickedFile?' 앞서 선택한 PDF는 그대로 유지했어요.':'')); return;
  }
  pickedFile = file; notice(); updateFile();
}
$('chooseFile').onclick = () => $('productFile').click();
$('changeFile').onclick=()=>{if(!submitting)$('productFile').click();};
$('productFile').onchange = event => chooseFile(event.target.files[0]);
$('removeFile').onclick = () => { pickedFile = null; $('productFile').value = ''; notice(); updateFile(); $('chooseFile').focus(); };
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('drag'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => {
  event.preventDefault(); $('dropzone').classList.remove('drag');
  if (name === 'drop') {
    if (event.dataTransfer.files.length !== 1) { notice('같은 선적의 서류를 묶은 PDF 한 개만 골라주세요.'); return; }
    chooseFile(event.dataTransfer.files[0]);
  }
});
$('liveStart').onclick = async () => {
  if (!pickedFile || submitting) return;
  if (!connection.can_execute) { openConnection(); return; }
  const submittedRoute = routeToken;
  submitting = true; updateFile(); notice();
  try {
    const row = await api('/api/upload?filename=' + encodeURIComponent(pickedFile.name), {method:'POST', headers:{'Content-Type':'application/pdf'}, body:pickedFile});
    pickedFile = null; $('productFile').value = '';
    submitting = false; updateFile();
    if (submittedRoute === routeToken) { rememberWaiting(row.id); navigate('/?run=' + row.id); }
    else if (new URLSearchParams(location.search).get('view') === 'history') refreshHistory(routeToken).catch(error=>notice(error.message));
  } catch (error) {
    submitting = false; updateFile();
    notice(error.message + ' 접수됐는지 확실하지 않다면 다시 올리기 전에 검증 기록을 확인해 주세요.');
  }
};
function setProgressMessage(message) {
  const line=$('progressMessage');if(line.textContent===message)return;
  line.replaceChildren(element('span',message,'phase-message-text'));
  line.classList.remove('phase-rise');void line.offsetWidth;line.classList.add('phase-rise');
}
function paintProgress(row) {
  showPage('progressView');
  document.title='검증 진행 · '+row.filename+' · TradeMatch';
  $('progressCard').classList.remove('is-complete');$('progressSpinner').hidden=false;
  $('progressEyebrow').textContent='검증 진행';$('resultReady').hidden=true;$('timeEstimate').hidden=false;
  $('waitingBackgroundMessage').textContent='다른 화면으로 이동해도 검증은 계속돼요.';
  mountHoopGame(row.id,'waitingGameHost');
  $('progressHeading').textContent = row.phase === 'queued' ? '문서가 접수됐어요. 검증 순서를 기다리고 있어요.' : '문서를 읽고 비교하고 있어요.';
  $('progressFilename').textContent = row.filename;
  setProgressMessage(({uploading:'고른 PDF를 보내고 있어요.', creating_job:'문서 확인을 요청하고 있어요.', queued:'Studio에서 문서를 확인할 준비를 하고 있어요.', in_progress:'Studio에서 문서를 분석하고 서로 다른 부분이 있는지 살펴보고 있어요.', retrieving:'이전에 요청한 문서가 어디까지 처리됐는지 확인하고 있어요.'})[row.phase] || '처리 상태를 확인하고 있어요.');
  const phaseCaption=({uploading:'PDF를 보내고 있어요',creating_job:'확인을 요청하고 있어요',queued:'순서를 기다리고 있어요',in_progress:'내용을 비교하고 있어요',retrieving:'처리 상태를 확인해요'})[row.phase]||'처리 상태를 확인해요';
  paintJourney('progressJourneyHost',row.phase==='uploading'?0:1,row.phase==='queued'?'queued':'working',phaseCaption);
  $('processVisual').dataset.phase=row.phase;$('processVisualLabel').textContent=phaseCaption;
}
function paintReady(row) {
  paintProgress(row);
  document.title='검증 완료 · '+row.filename+' · TradeMatch';
  $('progressCard').classList.add('is-complete');$('progressSpinner').hidden=true;
  $('progressEyebrow').textContent='검증 완료';$('progressHeading').textContent='문서 확인을 마쳤어요.';
  setProgressMessage('준비되면 결과 보기를 눌러주세요.');
  $('waitingBackgroundMessage').textContent='결과는 검증 기록에서도 다시 볼 수 있어요.';
  paintJourney('progressJourneyHost',2,'ready');
  $('processVisual').dataset.phase='completed';$('processVisualLabel').textContent='비교를 마쳤어요. 이제 결과를 확인해 주세요';
  $('timeEstimate').hidden=true;$('resultReady').hidden=false;$('viewResult').disabled=false;
}
$('viewResult').onclick=()=>{
  if(currentRow?.phase!=='completed')return;
  $('viewResult').disabled=true;rememberWaiting(currentRow.id,false);
  navigate('/?run='+currentRow.id,{replace:true});
};
async function monitor(id, token) {
  let first = true;
  while (token === routeToken) {
    const row = await api('/api/runs/' + id);
    if (token !== routeToken) return;
    currentRow = row;
    if (row.phase === 'completed') {
      stopClock();
      if (!row.analysis?.contract_valid || !row.analysis?.result) { renderError(row, '처리는 완료됐지만 판정 결과의 형식을 확인하지 못했습니다.'); return; }
      if(waitingResults.has(id)){paintReady(row);return;}
      const [source, raw] = await Promise.all([api('/api/runs/' + id + '/source'), readRaw(id).catch(() => null)]);
      if (token !== routeToken) return;
      renderResult(row, attachLocations(source, raw)); return;
    }
    if (!activePhases.has(row.phase)) {
      stopClock(); let raw = null;
      if (row.raw_file) { try { raw = await api('/api/runs/' + id + '/raw'); } catch {} }
      if (token === routeToken) renderError(row, null, raw);
      return;
    }
    rememberWaiting(id);paintProgress(row);
    if (first) { startClock(row); paintTimeEstimate(row,token); $('progressHeading').focus({preventScroll:true}); first = false; }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
}
function metadataPair(container, name, value) {
  container.append(element('dt', name), element('dd', value === null || value === undefined || value === '' ? '미확인' : String(value)));
}
function renderError(row, override = null, raw = null) {
  stopClock(); showPage('errorView'); currentRow = row;
  document.title='실행 확인'+(row?.filename?' · '+row.filename:'')+' · TradeMatch';
  const phase = row?.phase, providerError = raw?.error || {};
  const failed = (Array.isArray(raw?.output) ? raw.output : []).filter(step => step.status === 'failed').map(step => step.model).filter(Boolean);
  let message = override || row?.message || '기록을 불러오지 못했습니다. 연결 상태와 검증 기록을 확인하세요.';
  if (!override && providerError.code === 'model_request_error') message = 'Studio에서 문서를 분석하는 중 문제가 생겼어요.';
  $('errorHeading').textContent = phase === 'completed' ? '결과를 읽지 못했어요.' : phase === 'paused' ? '결과를 불러오다 멈췄어요.' : '검증을 마치지 못했어요.';
  $('errorFilename').textContent = row?.filename || '';
  $('errorMessage').textContent = message;
  $('errorNext').textContent = phase === 'failed' ? '문서를 비교하는 도중 오류가 생겼어요. 일치 여부는 아직 판단하지 못했어요.\n연결 설정과 Studio 워크플로우를 확인해 주세요.' : ['creation_unknown','upload_unknown'].includes(phase) ? '요청이 접수됐는지 확인하지 못했어요. 다시 올리기 전에 Studio에서 기존 작업을 확인해 주세요.' : phase === 'completed' ? '새 실행 전에 원본 응답과 연결된 워크플로우의 출력 형식을 확인해주세요.' : row?.job_id ? '이어서 결과 확인을 누르면 이미 요청한 작업의 결과를 다시 불러와요.' : '연결 상태를 확인한 뒤 검증 기록을 확인해주세요.';
  $('resumeRun').hidden = !row?.job_id || phase === 'completed' || !connection.can_retrieve;
  $('errorRaw').hidden = !row?.raw_file;
  if (row?.raw_file) $('errorRaw').href = '/api/runs/' + row.id + '/raw';
  $('errorDetails').replaceChildren();
  metadataPair($('errorDetails'), '실행 상태', phaseLabel[phase] || phase || '기록 미확인');
  metadataPair($('errorDetails'), '오류 코드', providerError.code);
  metadataPair($('errorDetails'), '오류 단계', failed.join(', '));
  metadataPair($('errorDetails'), 'Job ID', row?.job_id);
  metadataPair($('errorDetails'), '실행 버전', row?.settings_snapshot?.config_version);
  if (row?.analysis?.technical_issues?.length) metadataPair($('errorDetails'), '결과 점검', row.analysis.technical_issues.join('\n'));
  $('errorHeading').focus({preventScroll:true});
}
$('resumeRun').onclick = async () => {
  if (!currentRow?.job_id) return;
  const id = currentRow.id; $('resumeRun').disabled = true;
  try { await post('/api/runs/' + id + '/resume'); navigate('/?run=' + id, {replace:true}); }
  catch (error) { notice(error.message); }
  finally { $('resumeRun').disabled = false; }
};
// Display-only provenance: no verdict, conversion, or invoice arithmetic is performed here.
const rawCache = new Map();
let activeCheck = null, evidenceRefs = [], averageSeconds = null, estimateRequest = 0;
function readRaw(id) {
  if (!rawCache.has(id)) rawCache.set(id, api('/api/runs/' + id + '/raw').catch(error => { rawCache.delete(id); throw error; }));
  return rawCache.get(id);
}
function unpack(value) {
  for (let i = 0; i < 8 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value;
}
function pathValue(value, path) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
  for (const part of parts) {
    if (!part || ['__proto__', 'constructor', 'prototype'].includes(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function boxFromPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  if (!points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
  return right > left && bottom > top ? {x:left, y:top, width:right-left, height:bottom-top} : null;
}
function fieldLocation(meta) {
  if (!meta || typeof meta !== 'object' || !Number.isInteger(meta.page) || meta.page < 1) return null;
  const words = Array.isArray(meta.word_coordinates) ? meta.word_coordinates.map(boxFromPoints).filter(Boolean) : [];
  if (words.length) {
    // Merge neighboring word boxes on each printed line, never across distant rows.
    const rows = [];
    for (const box of words) {
      const row = rows.find(row => Math.abs(row.y - box.y) < Math.max(row.height, box.height));
      if (!row) rows.push({...box});
      else {
        const right = Math.max(row.x + row.width, box.x + box.width), bottom = Math.max(row.y + row.height, box.y + box.height);
        row.x = Math.min(row.x, box.x); row.y = Math.min(row.y, box.y); row.width = right-row.x; row.height = bottom-row.y;
      }
    }
    return {page:meta.page, boxes:rows, precision:'word'};
  }
  const region = boxFromPoints(meta.coordinates);
  return region ? {page:meta.page, boxes:[region], precision:'region'} : {page:meta.page, boxes:[], precision:'page'};
}
function attachLocations(source, raw) {
  const native = [], linked = [], documentLinks=[],itemLinks=[];
  for (const step of Array.isArray(raw?.output) ? raw.output : []) {
    if(String(step.model||'').endsWith('문서_연결_확인'))for(const block of step.content||[]){
      const data=referenceData(block.text);if(Array.isArray(data?.documents))linked.push(...data.documents);
      if(Array.isArray(data?.relationships))documentLinks.push(...data.relationships);
      if(Array.isArray(data?.item_links))itemLinks.push(...data.item_links);
    }
    if (step.step_type !== 'information-extract' && !String(step.model || '').startsWith('Information Extract - ')) continue;
    for (const block of step.content || []) {
      const data = unpack(block.text), meta = unpack(block.additional_values);
      if (!data || typeof data !== 'object' || !meta || typeof meta !== 'object') continue;
      const key = ['po_number','invoice_number','packing_list_number','bl_number'].find(key => Object.hasOwn(data,key));
      if (key) native.push({key, data, meta});
    }
  }
  return {...source,documentLinks,itemLinks, documents:source.documents.map(document => {
    const key = {PO:'po_number',CI:'invoice_number',PL:'packing_list_number',BL:'bl_number'}[document.kind];
    const matches = native.filter(item => item.key === key && item.data[key] === document.document_id && sameSourceData(item.data,document.data)&&
      (!document.page||!item.meta.page_ranges?.length||item.meta.page_ranges.some(range=>range[0]<=document.page&&range[1]>=document.page)));
    const aliases=linked.filter(item=>item.document_type===document.kind&&sameSourceData(item.extract,document.data));
    return {...document, source_key:aliases.length===1?aliases[0].source_key:null, locationMeta:matches.length === 1 ? matches[0].meta : null};
  })};
}
function referenceData(value){
  // Display-only document binding; never used to parse or repair the final verdict.
  for(let i=0;i<8&&typeof value==='string';i++){
    try{value=JSON.parse(value);}catch{
      const text=value.replace(/(?:\s*【[^】]*】)+\s*$/,'');if(text===value)return null;
      try{value=JSON.parse(text);}catch{return null;}
    }
  }
  return value;
}
function sameSourceData(a,b){
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&sameSourceData(a[key],b[key]));
}
function exactAnchor(document, value) {
  if (!document || !document.locationMeta) return null;
  const actual = pathValue(document.data, value.field), meta = pathValue(document.locationMeta, value.field);
  if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(value.value)) return null;
  if (Array.isArray(actual) && Array.isArray(meta)) {
    if (actual.length !== meta.length || !meta.every((item,i)=>item && Object.hasOwn(item,'_value') && JSON.stringify(item._value)===JSON.stringify(actual[i]))) return null;
    const locations=meta.map(fieldLocation).filter(Boolean), first=locations[0];
    if(!first)return null;
    return {page:first.page,boxes:locations.filter(item=>item.page===first.page).flatMap(item=>item.boxes),precision:locations.every(item=>item.precision==='word')?'word':'region'};
  }
  if (!meta || !Object.hasOwn(meta, '_value') || JSON.stringify(meta._value) !== JSON.stringify(actual)) return null;
  return fieldLocation(meta);
}
function refsFor(check) {
  const seen = new Set(), refs = [];
  for (const value of check.compared_values || []) {
    const key = value.document + ':' + value.field;
    if (seen.has(key)) continue; seen.add(key);
    const document = documentFor(value.document);
    refs.push({key, value, document, anchor:exactAnchor(document,value)});
  }
  return refs.length?refs:passSourceRefs(check);
}
function passSourceRefs(check){
  if(check.result!=='PASS')return [];
  const id=String(check.check_id||'').toUpperCase(),refs=[];
  for(const token of check.documents||[]){
    const doc=documentFor(token);if(!doc)continue;
    const item=/^([A-Z]+:\d+):items\[(\d+)\]$/.exec(token);
    let fields=[];
    if(item){
      const leaves=/QUANTITY_UNIT/.test(id)?['quantity_unit']:/QUANTITY|QTY/.test(id)?['quantity']:/UNIT_PRICE/.test(id)?['unit_price','price_basis']:/IDENTITY|ITEM_MAPPING/.test(id)?['sku','model']:[];
      fields=leaves.map(leaf=>'items['+item[2]+'].'+leaf);
    }else if(/INVOICE_TOTAL/.test(id))fields=['invoice_total'];
    else if(/CURRENCY/.test(id))fields=['currency'];
    else if(/PACKAGE_COUNT/.test(id))fields=['total_packages'];
    else if(/PACKAGE_UNIT/.test(id))fields=['package_unit'];
    else if(/GROSS_WEIGHT/.test(id))fields=['gross_weight'];
    else if(/WEIGHT_UNIT/.test(id))fields=['weight_unit'];
    else if(/DOCUMENT_LINK/.test(id))fields=id.startsWith('PO_CI')?[doc.kind==='PO'?'po_number':'po_numbers']:id.startsWith('CI_PL')?[doc.kind==='CI'?'invoice_number':'invoice_numbers']:['shipment_reference'];
    for(const field of fields.filter(Boolean)){
      const value=pathValue(doc.data,field);if(value===undefined)continue;
      const leaf=field.split('.').pop(),unit=leaf==='quantity'?pathValue(doc.data,field.replace(/quantity$/,'quantity_unit')):leaf==='unit_price'||leaf==='invoice_total'?doc.data.currency:leaf==='gross_weight'?doc.data.weight_unit:leaf==='total_packages'?doc.data.package_unit:null;
      const original={document:doc.document_id,field,value,unit:unit??null};
      refs.push({key:token+':'+field,value:original,document:doc,anchor:exactAnchor(doc,original),sourceContext:true});
    }
  }
  return refs;
}
function reportedCalculation(check, primary) {
  if (!primary || !/INVOICE_TOTAL|CI_TOTAL/.test(String(check.check_id).toUpperCase())) return null;
  const unit = primary.value.unit;
  if (!unit || !/^[A-Z]{3}$/.test(unit)) return null;
  // Do not infer the scope of arbitrary equations in narrative text.
  const basis = clean(check.basis), matches = [...basis.matchAll(new RegExp('(?:^|[.!?。\\n]\\s*)송장\\s*총액\\s*검산\\s*결과\\s*[:：=＝]\\s*([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*(' + unit + ')\\b','g'))];
  if (matches.length !== 1) return null;
  const differences = [...basis.matchAll(new RegExp('([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*' + unit + '\\s*(?:의\\s*)?(?:산술\\s*)?(?:불일치|차이)','g'))];
  return {value:matches[0][1], unit, difference:differences.length === 1 ? differences[0][1] + ' ' + unit : null};
}
let comparisonModel = null, comparisonPairs = [], compareZoom = false, pairSession = 0, connectorFrame = 0;
function semanticField(path) {
  const leaf=String(path).split('.').pop().replace(/\[\d+\]$/,'').replace(/_raw$/,'');
  return ({po_number:'po_reference',po_numbers:'po_reference',invoice_number:'invoice_reference',invoice_numbers:'invoice_reference'})[leaf]||leaf;
}
function comparisonValuesDiffer(left,right) {
  if(left.unit!==right.unit)return true;
  // A single document number and a one-number reference list show the same reference.
  // Keep source values/types intact for evidence anchors and the Studio verdict.
  const kind=semanticField(left.field);
  if(['po_reference','invoice_reference'].includes(kind)&&semanticField(right.field)===kind){
    if(typeof left.value==='string'&&Array.isArray(right.value)&&right.value.length===1&&right.value[0]===left.value)return false;
    if(typeof right.value==='string'&&Array.isArray(left.value)&&left.value.length===1&&left.value[0]===right.value)return false;
  }
  return JSON.stringify(left.value)!==JSON.stringify(right.value);
}
function preferredPairRefs(check, refs) {
  const groups=new Map();
  for(const ref of refs){
    const key=ref.value.document+':'+ref.value.field.replace(/_raw$/,'');
    const prior=groups.get(key), missing=ref.value.value===''||ref.value.value===null;
    if(!prior || (check.result==='REQUIRES_HUMAN_REVIEW'&&missing) || (prior.value.value!==''&&prior.value.value!==null&&!ref.value.field.endsWith('_raw')))groups.set(key,ref);
  }
  return [...groups.values()];
}
function pairCaption(ref){return fieldLabel(ref.value.field.replace(/_raw$/,''));}
function sourceRef(doc,field){
  const value=pathValue(doc.data,field);if(value===undefined)return null;
  const original={document:doc.document_id,field,value,unit:null};
  return {key:doc.source_key+':'+field,document:doc,value:original,anchor:exactAnchor(doc,original),sourceContext:true};
}
function confirmedReferencePairs(check){
  if(check.result!=='PASS'||!/DOCUMENT_LINK/.test(check.check_id))return [];
  const pair=/^(PO_CI|CI_PL|PL_BL)/.exec(check.check_id)?.[1],included=new Set((check.documents||[]).map(documentFor).filter(Boolean)),output=[];
  for(const relationship of currentSource?.documentLinks||[]){
    if(relationship.pair!==pair||relationship.link_status!=='CONFIRMED')continue;
    for(const from of relationship.from_sources||[])for(const to of relationship.to_sources||[]){
      const a=documentFor(from),b=documentFor(to);if(!a||!b||!included.has(a)||!included.has(b))continue;
      let left,right;
      if(pair==='PO_CI'||pair==='CI_PL'){
        const own=pair==='PO_CI'?'po_number':'invoice_number',list=pair==='PO_CI'?'po_numbers':'invoice_numbers',id=a.data[own],values=b.data[list];
        if(typeof id!=='string'||!id||!Array.isArray(values))continue;
        const indices=values.map((value,i)=>value===id?i:-1).filter(i=>i>=0);if(indices.length!==1)continue;
        left=sourceRef(a,own);right=sourceRef(b,list+'['+indices[0]+']');
      }else if(a.data.shipment_reference&&a.data.shipment_reference===b.data.shipment_reference){left=sourceRef(a,'shipment_reference');right=sourceRef(b,'shipment_reference');}
      if(left&&right)output.push({key:'reference:'+left.key+'|'+right.key,relation:'documents',label:pairCaption(left),left:{document:a,refs:[left],role:pairCaption(left)},right:{document:b,refs:[right],role:pairCaption(right)},links:[[0,0]]});
    }
  }
  return output;
}
function correspondenceAllowed(left,right){
  if(!left||!right)return false;
  if(!left.sourceContext&&!right.sourceContext)return true;
  if(!left.document?.source_key||!right.document?.source_key||comparisonValuesDiffer(left.value,right.value))return false;
  const a=left.document.source_key,b=right.document.source_key,ai=/^items\[(\d+)\]/.exec(left.value.field),bi=/^items\[(\d+)\]/.exec(right.value.field);
  if(ai||bi)return Boolean(ai&&bi&&(currentSource.itemLinks||[]).some(link=>link.link_status==='CONFIRMED'&&link.from_source===a&&link.to_source===b&&link.from_item_index===Number(ai[1])&&link.to_item_index===Number(bi[1])));
  return (currentSource.documentLinks||[]).some(link=>link.link_status==='CONFIRMED'&&link.from_sources?.includes(a)&&link.to_sources?.includes(b));
}
function missingDocumentKind(check){
  if(check.result!=='REQUIRES_HUMAN_REVIEW')return null;
  const id=String(check.check_id||'').toUpperCase();
  return ['PO','CI','PL','BL'].find(kind=>currentRow?.analysis?.result?.document_counts?.[kind]===0&&
    !currentSource?.documents?.some(document=>document.kind===kind)&&
    (/DOC_|DOCUMENT|EXIST|MISSING/.test(id)||new RegExp('(^|_)'+kind+'(_|$)').test(id)))||null;
}
function comparisonModels(check, refs) {
  const references=confirmedReferencePairs(check);if(references.length)return references;
  const candidates=preferredPairRefs(check,refs), total=candidates.find(ref=>ref.value.field==='invoice_total');
  const absent=missingDocumentKind(check);
  if(absent){
    const kind={BL:'PL',PL:'CI',CI:'PO',PO:'CI'}[absent],document=currentSource.documents.find(document=>document.kind===kind)||currentSource.documents[0]||null;
    return [{key:'missing-document',relation:'context',label:'필수 문서 확인',left:{document,refs:candidates.filter(ref=>ref.document===document),role:'제공된 원문'},right:{document:null,refs:[],role:'미제공 문서',missingKind:absent},links:[]}];
  }
  if(/CUMULATIVE/.test(String(check.check_id).toUpperCase())){
    const po=candidates.filter(ref=>ref.document?.kind==='PO'&&/\.quantity$/.test(ref.value.field)),ci=candidates.filter(ref=>ref.document?.kind==='CI'&&/\.quantity$/.test(ref.value.field));
    if(po.length===1&&ci.length)return ci.map((ref,index)=>({key:'cumulative:'+ref.key,relation:'cumulative',label:'송장 '+(index+1)+' / '+ci.length+' · '+ref.document.document_id,left:{document:po[0].document,refs:po,role:'발주 수량'},right:{document:ref.document,refs:[ref],role:'누적 검사에 포함된 송장'},links:[],sourceCount:ci.length}));
  }
  if(/INVOICE_TOTAL|CI_TOTAL/.test(String(check.check_id).toUpperCase())&&total){
    const inputs=candidates.filter(ref=>ref.value.document===total.value.document&&/\.quantity$|\.unit_price$/.test(ref.value.field));
    if(inputs.length)return [{key:'invoice-calculation',relation:'calculation',label:'품목 내역과 송장 총액',left:{document:total.document,refs:inputs,role:'품목 내역'},right:{document:total.document,refs:[total],role:'기재 총액'},links:inputs.map((_,i)=>[i,0]),calculation:reportedCalculation(check,total)}];
  }
  const gross=candidates.find(ref=>ref.value.field==='gross_weight'),net=candidates.find(ref=>ref.value.field==='net_weight');
  if(gross&&net&&gross.document===net.document&&candidates.every(ref=>ref.value.document===gross.value.document))return [{key:'internal-weight',relation:'internal',label:'총중량과 순중량',left:{document:gross.document,refs:[gross],role:'총중량'},right:{document:net.document,refs:[net],role:'순중량'},links:[[0,0]]}];
  const fields=new Map();
  for(const ref of candidates){if(!ref.document)continue;const key=semanticField(ref.value.field);if(!fields.has(key))fields.set(key,new Map());const documents=fields.get(key);if(!documents.has(ref.value.document))documents.set(ref.value.document,[]);documents.get(ref.value.document).push(ref);}
  const output=[], order={PO:0,CI:1,PL:2,BL:3};
  for(const [field,documents]of fields){
    const unique=[...documents.values()].filter(values=>values.length===1).map(values=>values[0]).sort((a,b)=>(order[a.document.kind]??9)-(order[b.document.kind]??9));
    for(let i=0;i<unique.length;i++)for(let j=i+1;j<unique.length;j++){
      const left=unique[i],right=unique[j],kinds=left.document.kind+'_'+right.document.kind;
      if(!['PO_CI','CI_PL','PL_BL'].includes(kinds))continue;
      output.push({key:left.key+'|'+right.key,relation:'documents',label:pairCaption(left),left:{document:left.document,refs:[left],role:pairCaption(left)},right:{document:right.document,refs:[right],role:pairCaption(right)},links:[[0,0]]});
    }
  }
  if(output.length){
    if(check.result==='FAIL'){
      const different=output.filter(pair=>JSON.stringify(pair.left.refs[0].value.value)!==JSON.stringify(pair.right.refs[0].value.value)||pair.left.refs[0].value.unit!==pair.right.refs[0].value.unit);
      const discrepancies=currentRow?.analysis?.result?.issues?.filter(issue=>issue.type==='DISCREPANCY')||[];
      const confirmed=different.filter(pair=>discrepancies.some(issue=>[pair.left.refs[0],pair.right.refs[0]].every(ref=>issue.documents.some(id=>id===ref.value.document||documentFor(id)===ref.document)&&issue.fields.includes(ref.value.field))));
      if(confirmed.length)return confirmed;
      return output.map(pair=>({...pair,relation:'context',links:[]}));
    }
    if(check.result==='REQUIRES_HUMAN_REVIEW')output.sort((a,b)=>Number([...b.left.refs,...b.right.refs].some(ref=>ref.value.value===''||ref.value.value===null))-Number([...a.left.refs,...a.right.refs].some(ref=>ref.value.value===''||ref.value.value===null)));
    return output;
  }
  const documents=[...new Set([...candidates.map(ref=>ref.document),...(check.documents||[]).map(documentFor)].filter(Boolean))].sort((a,b)=>(order[a.kind]??9)-(order[b.kind]??9));
  const missingKind=missingDocumentKind(check);
  return [{key:'source-context',relation:'context',label:'선택 검사의 원문',left:{document:documents[0]||null,refs:candidates.filter(ref=>ref.document===documents[0]),role:'검사 근거'},right:{document:documents[1]||null,refs:candidates.filter(ref=>documents[1]&&ref.document===documents[1]),role:'검사 근거',missingKind:documents[1]?null:missingKind},links:[]}];
}
function activateCheck(check, preferred = null) {
  if(!check)return;
  if(reviewFilter!=='all'&&!(reviewFilter==='attention'&&check.result!=='PASS')&&check.result!==reviewFilter)reviewFilter='all';
  const previous=activeCheck===check?comparisonModel?.key:null;
  activeCheck=check;evidenceRefs=refsFor(check);
  comparisonPairs=comparisonModels(check,evidenceRefs);
  const selected=(preferred&&comparisonPairs.find(pair=>[...pair.left.refs,...pair.right.refs].some(ref=>ref.key===preferred.key)))||comparisonPairs.find(pair=>pair.key===previous)||primaryComparison(check,comparisonPairs);
  paintComparison(selected);
}
function primaryComparison(check,pairs) {
  const refs=pair=>[...pair.left.refs,...pair.right.refs];
  if(check.result==='REQUIRES_HUMAN_REVIEW'){
    const missing=pairs.find(pair=>refs(pair).some(ref=>ref.value.value===''||ref.value.value===null));
    if(missing)return missing;
  }
  const id=String(check.check_id).toUpperCase(),topics=[
    [/INVOICE_TOTAL|CI_TOTAL/,/^invoice_total$/],
    [/INTERNAL.*WEIGHT|WEIGHT.*INTERNAL|GROSS|WEIGHT/,/^gross_weight$/],
    [/PACKAGE/,/^total_packages$/],
    [/CURRENCY/,/^currency$/],
    [/QUANTITY|QTY/,/^quantity$/],
    [/PRICE|PRICING/,/^unit_price$/],
    [/MODEL/,/^model$/],
    [/SKU/,/^sku$/]
  ];
  const topic=topics.find(([pattern])=>pattern.test(id));
  return (topic&&pairs.find(pair=>refs(pair).some(ref=>topic[1].test(semanticField(ref.value.field)))))||pairs[0];
}
function orderedChecks(checks=currentRow?.analysis?.result?.checks||[]) {
  const rank={FAIL:0,REQUIRES_HUMAN_REVIEW:1,PASS:2};
  return [...checks].sort((a,b)=>(rank[a.result]??1)-(rank[b.result]??1));
}
function reviewDeck() {
  const checks=orderedChecks();
  return reviewFilter==='all'?checks:checks.filter(check=>reviewFilter==='attention'?check.result!=='PASS':check.result===reviewFilter);
}
function focusReviewCard() {
  if(guidedReview){$('guidedHost').focus({preventScroll:true});return;}
  openGuidedReview(activeCheck,$('reportOpen'));
}
function paintReviewCard() {
  const checks=reviewDeck(),index=checks.indexOf(activeCheck),all=currentRow.analysis.result.checks;
  $('checkPosition').textContent=(index+1)+' / '+checks.length;
  const scope=reviewFilter==='all'?'전체 항목':reviewFilter==='attention'?'확인할 항목':reviewFilter==='REQUIRES_HUMAN_REVIEW'?'검토 필요':statusLabel(reviewFilter);
  $('reviewControlLabel').textContent='↑ '+scope+' '+(index+1)+' / '+checks.length+' · '+friendly(activeCheck);
  $('reviewAll').hidden=reviewFilter==='all';$('reviewAll').textContent='전체 '+all.length+'개 항목 보기';
  $('checkDocuments').textContent=(activeCheck.documents||[]).map(documentCaption).join(' · ');
  if(renderedReviewCheck!==activeCheck){
    renderedReviewCheck=activeCheck;
    $('reasonDetails').open=false;
    $('checkReason').textContent=clean(activeCheck.basis||'이 항목에는 판단 이유가 남아 있지 않아요.');
    $('checkReviewCard').classList.remove('reason-expanded');
    $('expandCheckReason').hidden=false;$('expandCheckReason').textContent='설명 더 보기';$('expandCheckReason').setAttribute('aria-expanded','false');
  }
  requestAnimationFrame(updateReasonToggle);
  $('previousCheck').disabled=index<=0;$('nextCheck').disabled=!guidedReview&&index>=checks.length-1;
  $('nextCheck').textContent=index>=checks.length-1?(guidedReview?'따라보기 마치기':'마지막 항목'):'다음 항목 →';
  $('guidedPosition').textContent=scope+' '+(index+1)+' / '+checks.length;
  $('reviewEnd').hidden=index!==checks.length-1;
  $('reviewEnd').textContent=reviewFilter==='all'?'마지막 항목까지 왔어요. 이전 항목을 다시 보거나 아래에서 문서 원본을 확인해 보세요.':'선택한 종류의 마지막 항목이에요. 전체 항목으로 돌아가 다른 결과도 확인해 보세요.';
}
function updateReasonToggle() {
  if($('resultView').hidden)return;
  const reason=$('checkReason'),expanded=$('checkReviewCard').classList.contains('reason-expanded');
  $('expandCheckReason').hidden=!expanded&&reason.scrollHeight<=reason.clientHeight+1;
}
function moveReviewCard(direction) {
  const checks=reviewDeck();
  if(!checks.length||$('resultView').hidden)return false;
  const index=checks.indexOf(activeCheck),next=index+direction;
  if(next<0||next>=checks.length)return false;
  activateCheck(checks[next]);if(checks[next].result==='PASS')checkFilter='all';paintChecks();
  const card=guidedReview?$('guidedHost'):$('checkReviewCard');
  card.classList.remove('review-forward','review-backward');void card.offsetWidth;
  card.classList.add(direction>0?'review-forward':'review-backward');
  if(guidedReview){$('guidedHost').scrollTop=0;$('comparisonScroll').scrollLeft=0;}
  card.focus({preventScroll:true});return true;
}
function focusEvidence(check, ref, zoom = true) {
  compareZoom=zoom;activateCheck(check,ref);
  if(!guidedReview)openGuidedReview(check);
  $('comparisonWorkspace').scrollIntoView({behavior:scrollBehavior(),block:'start'});
}
function comparisonValue(ref){if(!ref)return '';const value=ref.value.value;return value===''||value===null?'문서에서 확인해 주세요':Array.isArray(value)?value.map(String).join(' · '):rawValue(value,ref.value.unit);}
function comparisonGuide(model) {
  const name=document=>document?.kind==='BL'?'선하증권(B/L)':documentLabel[document?.kind]||'문서';
  const missing=model.right.missingKind||model.left.missingKind;
  if(missing)return '이번 PDF에서 '+name({kind:missing})+'을 찾지 못했어요. 필요한 서류가 모두 들어 있는지 확인해 주세요.';
  const refs=[...model.left.refs,...model.right.refs];
  if(model.relation==='cumulative')return '이 검사는 송장 '+model.sourceCount+'건의 누적 수량을 확인한 결과예요. '+(model.sourceCount>1?'탭을 넘기며 각 송장을 살펴보세요. ':'')+'한 송장의 수량과 발주 수량의 차이만으로 판정하지 않아요.';
  if(refs.some(ref=>ref.sourceContext))return correspondenceAllowed(model.left.refs[0],model.right.refs[0])?'같은 값을 가리키는 두 원문 위치를 선으로 연결했어요. Studio가 확인한 문서·품목 연결을 기준으로 보여드려요.':'일치로 판정된 항목이에요. 연결된 문서의 참고 원문을 보여드려요.';
  const blank=refs.find(ref=>ref.value.value===''||ref.value.value===null);
  if(blank)return name(blank.document)+'에서 '+fieldLabel(blank.value.field)+' 값을 확인하지 못했어요. 문서 원본을 살펴봐 주세요.';
  if(model.relation==='calculation')return '비교한 송장 합계는 '+comparisonValue(model.right.refs[0])+'예요. '+(model.calculation?'계산한 합계는 '+model.calculation.value+' '+model.calculation.unit+'예요. ':'')+'아래 품목 내역과 총액을 함께 확인해 보세요.';
  if(['documents','internal'].includes(model.relation)&&model.left.refs.length===1&&model.right.refs.length===1){
    const left=model.left.refs[0],right=model.right.refs[0];
    const label=ref=>name(ref.document)+(model.relation==='internal'?'의 '+fieldLabel(ref.value.field):'');
    return '이번에 비교한 값은 '+label(left)+' '+comparisonValue(left)+', '+label(right)+' '+comparisonValue(right)+'예요. 아래 표시된 부분을 함께 확인해 보세요.';
  }
  return '이 항목을 판단할 때 살펴본 문서를 아래에 모았어요. 자세한 판단 이유와 문서 원본을 함께 확인해 주세요.';
}
function makePaper(side,model,session){
  const prefix='compare'+side,doc=model.document,refs=model.refs||[],page=refs.find(ref=>ref.anchor?.page)?.anchor.page||doc?.page||1;
  const article=$(prefix+'Paper'),stage=$(prefix+'Stage'),overlay=$(prefix+'Overlay');
  article.className='comparison-paper '+(comparisonModel.relation==='context'||comparisonModel.relation==='cumulative'||refs.some(ref=>ref.sourceContext)||comparisonModel.relation==='calculation'&&side==='Left'?'supporting':statusTone(activeCheck.result));
  $(prefix+'Title').textContent=doc?(documentLabel[doc.kind]||doc.kind)+(comparisonModel.relation==='documents'?'':' · '+model.role):model.missingKind?documentLabel[model.missingKind]+' 미제공':'비교할 문서 확인이 필요해요';
  $(prefix+'Meta').textContent=doc?doc.document_id+' · '+page+'페이지':'';
  $(prefix+'Value').textContent=refs.length===1?comparisonValue(refs[0]):refs.length?'검사에 사용한 항목 '+refs.length+'곳':'';
  $(prefix+'Field').textContent=refs.length===1?pairCaption(refs[0]):model.role;
  $(prefix+'Open').hidden=!doc||!currentSource.has_pdf;
  if(doc&&currentSource.has_pdf)$(prefix+'Open').href=currentSource.pdf_url+'#page='+page;
  stage.style.width='';stage.dataset.view='';stage.classList.toggle('enlarged',compareZoom);overlay.replaceChildren();
  $(prefix+'Viewport').scrollTop=0;$(prefix+'Viewport').scrollLeft=0;
  let precise=0;
  refs.forEach((ref,index)=>{
    if(ref.anchor?.page!==page)return;
    for(const box of ref.anchor.boxes||[]){
      precise++;
      const rect=svgElement('rect',{x:Math.max(0,box.x*1000-4),y:Math.max(0,box.y*1000-4),width:box.width*1000+8,height:box.height*1000+8,rx:3,class:'comparison-mark','data-ref':index,'data-field':ref.value.field});
      const title=svgElement('title');title.textContent=pairCaption(ref)+' · '+comparisonValue(ref);rect.append(title);overlay.append(rect);
    }
  });
  $(prefix+'Note').textContent=!doc?(model.missingKind?'해당 문서가 제공되지 않아 비교할 원문이 없습니다.':'이 검사에서 대응 원문을 확정할 수 없습니다.'):!precise?'표시할 위치를 찾지 못했어요. 페이지 전체에서 확인하거나 원문을 확대해 주세요.':comparisonModel.relation==='calculation'&&side==='Left'?'네모 안의 수량과 단가로 합계를 확인했어요. 표시된 값이 모두 틀렸다는 뜻은 아니에요.':'네모 안이 이번에 확인한 부분이에요. 스크롤로 주변 내용도 살펴볼 수 있어요.';
  if(precise&&refs.some(ref=>ref.sourceContext))$(prefix+'Note').textContent=correspondenceAllowed(comparisonModel.left.refs[0],comparisonModel.right.refs[0])?'연결된 문서에서 같은 값이 적힌 위치예요.':'연결된 문서의 참고 위치예요. 이 항목의 세부 비교 근거는 제공되지 않았어요.';
  $(prefix+'Fit').hidden=!doc||!currentSource.preview_url;
  $(prefix+'Viewport').setAttribute('tabindex','0');$(prefix+'Viewport').setAttribute('role','region');
  $(prefix+'Viewport').setAttribute('aria-label',(doc?documentLabel[doc.kind]||doc.kind:'문서')+' 원문 · 스크롤로 이동');
  const old=$(prefix+'Image'),image=element('img');image.id=prefix+'Image';image.alt=doc?(documentLabel[doc.kind]||doc.kind)+' '+page+'페이지 원문':'비교할 원문 없음';image.hidden=true;old.replaceWith(image);
  const empty=$(prefix+'Empty');empty.hidden=false;empty.textContent=!doc?(model.missingKind?documentLabel[model.missingKind]+' 문서가 없습니다.':'이 검사에 대응하는 두 번째 원문이 없습니다.'):!currentSource.has_pdf?'원본 PDF가 보관되어 있지 않습니다.':'원문 페이지를 불러오고 있습니다.';
  article.dataset.page=page;
  image.onload=()=>{if(session!==pairSession)return;image.hidden=false;empty.hidden=true;setPaperView(side,precise||compareZoom?'detail':'page');scheduleComparisonLines();};
  image.onerror=()=>{if(session!==pairSession)return;empty.hidden=false;empty.textContent='미리보기를 준비하지 못했습니다. 원본 PDF를 열어 확인해주세요.';scheduleComparisonLines();};
  if(doc&&currentSource.has_pdf&&currentSource.preview_url)image.src=currentSource.preview_url+'?page='+page;
  else if(doc&&currentSource.has_pdf)empty.textContent='원본 이미지 위치를 준비하지 못했습니다. 원본 PDF를 열어 확인해주세요.';
}
function setPaperView(side,view){
  const prefix='compare'+side,image=$(prefix+'Image'),stage=$(prefix+'Stage'),viewport=$(prefix+'Viewport');
  if(image.hidden)return;
  stage.dataset.view=view;stage.classList.toggle('enlarged',view==='detail'&&compareZoom);
  if(view==='page'){
    const ratio=image.naturalWidth/image.naturalHeight;
    stage.style.width=Math.max(1,Math.min(viewport.clientWidth-2,(viewport.clientHeight-2)*ratio))+'px';
    viewport.scrollTop=0;viewport.scrollLeft=0;
  }else{
    stage.style.width='';viewport.scrollTop=0;viewport.scrollLeft=0;
    focusPaper(side,comparisonModel[side.toLowerCase()],Number($(prefix+'Paper').dataset.page));
  }
  $(prefix+'Fit').textContent=view==='page'?'원문 확대':'페이지 전체';
  $(prefix+'Fit').setAttribute('aria-label',(view==='page'?'원문 확대':'페이지 전체 보기')+' · '+$(prefix+'Title').textContent);
  $(prefix+'Fit').setAttribute('aria-pressed',String(view==='page'));
  scheduleComparisonLines();
}
function focusPaper(side,model,page){
  const image=$('compare'+side+'Image'),viewport=$('compare'+side+'Viewport'),box=model.refs.find(ref=>ref.anchor?.page===page&&ref.anchor.boxes.length)?.anchor.boxes[0];
  if(image.hidden)return;
  if(!box){viewport.scrollTop=0;viewport.scrollLeft=0;return;}
  viewport.scrollTop=Math.max(0,(box.y+box.height/2)*image.clientHeight-viewport.clientHeight*.45);
  viewport.scrollLeft=Math.max(0,(box.x+box.width/2)*image.clientWidth-viewport.clientWidth*.5);
}
function paintComparison(model){
  if(!model||!currentRow)return;
  comparisonModel=model;const session=++pairSession;
  const single=Boolean(model.left.document&&!model.right.document&&!model.right.missingKind);
  $('comparisonBoard').dataset.single=String(single);$('compareRightPaper').hidden=single;
  document.querySelector('.comparison-quick-values').hidden=single;
  $('comparisonWorkspace').className='comparison-workspace '+statusTone(activeCheck.result);
  $('comparisonTitle').textContent=friendly(activeCheck);
  $('comparisonStatus').textContent=statusLabel(activeCheck.result);$('comparisonStatus').className='status-pill '+statusTone(activeCheck.result);
  paintReviewCard();
  $('checkPlainSummary').textContent=comparisonGuide(model);
  const attention=currentRow.analysis.result.checks.filter(check=>check.result!=='PASS');
  $('selectedCheckContext').textContent=activeCheck.result==='PASS'?'현재 선택한 검사는 일치입니다.'+(attention.length?' 전체 검사에는 다른 확인 필요 항목 '+attention.length+'건이 남아 있습니다.':''):activeCheck.result==='FAIL'?'현재 선택한 검사에서 불일치가 확인됐습니다.':'현재 선택한 검사는 담당자 확인이 필요합니다.';
  $('comparisonHelp').textContent=model.relation==='calculation'?'같은 송장의 품목 내역과 총액을 비교해요. 선으로 이어진 수량과 단가가 계산에 사용됐어요.':model.relation==='internal'?'같은 문서에 적힌 총중량과 순중량을 비교해요.':model.relation==='context'?'정확히 짝지을 수 있는 위치를 찾지 못했어요. 아래 문서와 판단 이유를 함께 확인해 주세요.':'두 문서의 네모 안을 확인해 보세요. 선으로 이어진 값이 이번에 비교한 부분이에요.';
  $('comparisonSummary').textContent=model.calculation?'기재 총액 '+comparisonValue(model.right.refs[0])+' · 검산 합계 '+model.calculation.value+' '+model.calculation.unit+(model.calculation.difference?' · 차이 '+model.calculation.difference:''):'';
  $('comparisonSummary').hidden=!model.calculation;
  const checks=currentRow.analysis.result.checks;
  $('compareCheckSelect').replaceChildren();orderedChecks(checks).forEach((check,index)=>{const option=element('option',(index+1)+'. '+statusLabel(check.result)+' · '+friendly(check));option.value=checks.indexOf(check);option.selected=check===activeCheck;$('compareCheckSelect').append(option);});
  $('comparisonPairs').replaceChildren();$('comparisonPairs').hidden=comparisonPairs.length<2;
  for(const pair of comparisonPairs){const button=element('button',pair.label,'pair-choice'+(pair.key===model.key?' active':''));button.type='button';button.setAttribute('aria-pressed',String(pair.key===model.key));button.onclick=()=>paintComparison(pair);$('comparisonPairs').append(button);}
  $('compareZoom').textContent=compareZoom?'기본 크기':'크게 보기';$('compareZoom').setAttribute('aria-pressed',String(compareZoom));
  $('comparisonLines').replaceChildren();makePaper('Left',model.left,session);makePaper('Right',model.right,session);
  for(const side of ['Left','Right']){
    $('quick'+side+'Title').textContent=$('compare'+side+'Title').textContent;
    $('quick'+side+'Value').textContent=$('compare'+side+'Value').textContent||'대응 원문 확인 필요';
  }
  const left=model.left.refs[0]?.value,right=model.right.refs[0]?.value;
  $('comparisonValueNote').hidden=!(activeCheck.result==='PASS'&&model.relation==='documents'&&left&&right&&comparisonValuesDiffer(left,right));
  scheduleComparisonLines();
}
function connectorCurve(start,end){const middle=(start.x+end.x)/2;return 'M '+start.x+' '+start.y+' C '+middle+' '+start.y+' '+middle+' '+end.y+' '+end.x+' '+end.y;}
function visibleEndpoint(side,index){
  const viewport=$('compare'+side+'Viewport'),view=viewport.getBoundingClientRect(),rects=[...$('compare'+side+'Overlay').querySelectorAll('[data-ref="'+index+'"]')];
  if($('compare'+side+'Image').hidden)return null;
  for(const rect of rects){const box=rect.getBoundingClientRect();if(box.width<=0||box.height<=0)continue;const y=box.top+box.height/2;if(y<view.top||y>view.bottom)continue;if(box.right<view.left||box.left>view.right)continue;return {x:side==='Left'?Math.min(box.right,view.right):Math.max(box.left,view.left),y};}
  return null;
}
function drawComparisonLines(){
  const overlay=$('comparisonLines');overlay.replaceChildren();
  if(!comparisonModel||$('resultView').hidden)return;
  const board=$('comparisonBoard').getBoundingClientRect();if(!board.width||!board.height)return;
  overlay.setAttribute('viewBox','0 0 '+board.width+' '+board.height);
  overlay.setAttribute('class','comparison-lines '+(comparisonModel.relation==='calculation'?'supporting':statusTone(activeCheck.result)));
  for(const [left,right]of comparisonModel.links){
    if(!correspondenceAllowed(comparisonModel.left.refs[left],comparisonModel.right.refs[right]))continue;
    const a=visibleEndpoint('Left',left),b=visibleEndpoint('Right',right);if(!a||!b)continue;
    const start={x:a.x-board.left,y:a.y-board.top},end={x:b.x-board.left,y:b.y-board.top};
    const line=svgElement('path',{d:connectorCurve(start,end),fill:'none',class:'comparison-connector','data-left':left,'data-right':right});
    const title=svgElement('title');title.textContent=comparisonModel.relation==='calculation'?'검산에 사용한 항목 연결':pairCaption(comparisonModel.left.refs[left])+' · '+statusLabel(activeCheck.result);line.append(title);overlay.append(line);
    for(const point of [start,end])overlay.append(svgElement('circle',{cx:point.x,cy:point.y,r:1.6,class:'connector-end'}));
  }
}
function scheduleComparisonLines(){cancelAnimationFrame(connectorFrame);connectorFrame=requestAnimationFrame(drawComparisonLines);}
$('compareCheckSelect').onchange=()=>{const check=currentRow?.analysis?.result?.checks[Number($('compareCheckSelect').value)];if(!check)return;activateCheck(check);if(check.result==='PASS')checkFilter='all';paintChecks();};
$('previousCheck').onclick=()=>moveReviewCard(-1);
$('nextCheck').onclick=()=>{if(guidedReview&&reviewDeck().indexOf(activeCheck)===reviewDeck().length-1)closeGuidedReview();else moveReviewCard(1);};
$('reviewControlLabel').onclick=focusReviewCard;
$('reviewAll').onclick=()=>{reviewFilter='all';paintReviewCard();$('checkReviewCard').focus({preventScroll:true});};
function openGuidedReview(start=null,returnFocus=null) {
  const checks=reviewDeck();if(!checks.length||$('resultView').hidden||guidedReview)return;
  guidedScrollY=window.scrollY;guidedReturnFocus=returnFocus?.isConnected?returnFocus:$('guidedStart');guidedReview=true;
  $('guidedFilename').textContent=currentRow.filename;
  $('comparisonWorkspace').hidden=false;$('guidedHost').append($('comparisonWorkspace'));document.body.classList.add('guided-open');
  $('guidedDialog').showModal();
  $('checkReviewCard').classList.remove('review-forward','review-backward');
  activateCheck(checks.includes(start)?start:checks[0]);paintChecks();$('guidedHost').focus({preventScroll:true});
  requestAnimationFrame(()=>{updateReasonToggle();scheduleComparisonLines();});
}
function closeGuidedReview(restoreFocus=true) {
  if(!guidedReview)return;guidedReview=false;
  $('guidedReturnPoint').after($('comparisonWorkspace'));$('comparisonWorkspace').hidden=true;document.body.classList.remove('guided-open');
  if($('guidedDialog').open)$('guidedDialog').close();
  $('guidedHost').classList.remove('review-forward','review-backward');
  if(activeCheck)paintReviewCard();scheduleComparisonLines();
  if(restoreFocus&&!$('resultView').hidden){window.scrollTo(0,guidedScrollY);(guidedReturnFocus?.isConnected?guidedReturnFocus:$('guidedStart')).focus({preventScroll:true});}
}
$('guidedStart').onclick=()=>openGuidedReview();
$('guidedClose').onclick=()=>closeGuidedReview();
$('guidedDialog').addEventListener('close',()=>closeGuidedReview());
$('guidedDialog').addEventListener('cancel',event=>{event.preventDefault();closeGuidedReview();});
$('guidedDialog').addEventListener('keydown',event=>{
  if(!guidedReview||event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeGuidedReview();return;}
  if(event.target.closest('button,a,input,select,textarea,summary,.compare-viewport,[contenteditable="true"]'))return;
  const next=event.key==='ArrowRight'&&!event.shiftKey;
  const previous=event.key==='ArrowLeft'&&!event.shiftKey;
  if(!next&&!previous)return;
  event.preventDefault();event.stopPropagation();if(event.repeat)return;
  moveReviewCard(previous?-1:1);
},true);
$('checkReviewCard').addEventListener('keydown',event=>{
  if(event.target!==$('checkReviewCard')||event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
  if(event.key==='Escape'){$('compareFocus').focus({preventScroll:true});return;}
  if(event.shiftKey)return;
  if(event.key==='ArrowRight'){
    event.preventDefault();
    if(!event.repeat)moveReviewCard(1);
  }else if(event.key==='ArrowLeft'){event.preventDefault();if(!event.repeat)moveReviewCard(-1);}
});
$('expandCheckReason').onclick=()=>{
  const expanded=$('checkReviewCard').classList.toggle('reason-expanded');
  $('expandCheckReason').textContent=expanded?'설명 접기':'설명 더 보기';$('expandCheckReason').setAttribute('aria-expanded',String(expanded));
  updateReasonToggle();
};
$('reasonDetails').addEventListener('toggle',()=>{requestAnimationFrame(updateReasonToggle);scheduleComparisonLines();});
window.addEventListener('resize',updateReasonToggle);
$('compareZoom').onclick=()=>{compareZoom=!compareZoom;paintComparison(comparisonModel);};
$('compareFocus').onclick=()=>{if(!comparisonModel)return;for(const side of ['Left','Right']){const model=comparisonModel[side.toLowerCase()];setPaperView(side,model.refs.some(ref=>ref.anchor?.boxes?.length)?'detail':'page');}scheduleComparisonLines();$('comparisonBoard').scrollIntoView({behavior:scrollBehavior(),block:'start'});};
for(const side of ['Left','Right']){
  $('compare'+side+'Viewport').addEventListener('scroll',scheduleComparisonLines,{passive:true});
  $('compare'+side+'Fit').onclick=()=>setPaperView(side,$('compare'+side+'Stage').dataset.view==='page'?'detail':'page');
}
function resizePaperPages(){for(const side of ['Left','Right'])if($('compare'+side+'Stage').dataset.view==='page')setPaperView(side,'page');}
window.addEventListener('resize',resizePaperPages,{passive:true});
if(typeof ResizeObserver!=='undefined')for(const side of ['Left','Right'])new ResizeObserver(resizePaperPages).observe($('compare'+side+'Viewport'));
window.addEventListener('resize',scheduleComparisonLines,{passive:true});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(scheduleComparisonLines).observe($('comparisonBoard'));

function svgElement(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
  return node;
}
function processingSeconds(raw) {
  if (raw?.status !== 'completed' || !Number.isFinite(raw.created_at)) return null;
  const times=(Array.isArray(raw.output)?raw.output:[]).map(step=>step.updated_at).filter(Number.isFinite);
  if(!times.length)return null;
  const seconds=Math.max(...times)-raw.created_at;
  return seconds>0 && seconds<86400 ? seconds : null;
}
function setTimeEstimate(text){$('timeEstimate').textContent=text;$('uploadEstimate').textContent=text;}
async function paintTimeEstimate(row, token) {
  const request=++estimateRequest; averageSeconds=null;
  setTimeEstimate('문서 분석·비교는 분 단위로 진행될 수 있습니다.');
  try {
    const {runs}=await api('/api/runs'), settings=row.settings_snapshot||{};
    const rows=runs.filter(item=>item.phase==='completed' && item.source==='studio_api' && item.job_id!==row.job_id && item.settings_snapshot?.agent_id===settings.agent_id && item.settings_snapshot?.project_id===settings.project_id && item.settings_snapshot?.config_version===settings.config_version);
    const seen=new Set(), recent=rows.filter(item=>{if(seen.has(item.job_id))return false;seen.add(item.job_id);return true;}).slice(0,8);
    const values=await Promise.allSettled(recent.map(item=>readRaw(item.id)));
    if(token!==routeToken||request!==estimateRequest)return;
    const seconds=values.filter(value=>value.status==='fulfilled').map(value=>processingSeconds(value.value)).filter(Number.isFinite);
    if(!seconds.length){setTimeEstimate('아직 이 검증 설정의 평균 기록이 없습니다. 문서 분량과 대기 상태에 따라 시간이 달라집니다.');return;}
    averageSeconds=seconds.reduce((sum,value)=>sum+value,0)/seconds.length;
    const minutes=Math.max(1,Math.round(averageSeconds/60));
    setTimeEstimate((seconds.length===1?'최근 같은 설정 1건은':'최근 같은 설정 '+seconds.length+'건의 평균은')+' 약 '+minutes+'분입니다. 문서 분량·대기 상태에 따라 더 걸릴 수 있습니다.');
  } catch { if(token===routeToken&&request===estimateRequest)setTimeEstimate('문서 분량과 대기 상태에 따라 처리 시간이 달라집니다. 완료되면 이 화면에 결과가 표시됩니다.'); }
}

function friendly(check){
  const title=friendlyTitle(check),rows=(check.documents||[]).map(id=>/^\w+:\d+:items\[(\d+)\]$/.exec(id)?.[1]).filter(value=>value!==undefined);
  return rows.length&&new Set(rows).size===1?'품목 '+(Number(rows[0])+1)+' · '+title:title;
}
function friendlyTitle(check) {
  const missing=missingDocumentKind(check);if(missing)return (documentLabel[missing]||missing)+' 제공 여부 확인';
  const id = String(check.check_id || '').toUpperCase();
  if(/ITEM_MAPPING/.test(id))return '품목 연결 확인';
  if(/CUMULATIVE/.test(id))return '누적 선적 수량 확인';
  if(/QUANTITY_UNIT/.test(id))return '수량 단위 비교';
  if(/WEIGHT_UNIT/.test(id))return '중량 단위 비교';
  if(/PACKAGE_UNIT/.test(id))return '포장 단위 비교';
  if (/INVOICE_TOTAL|CI_TOTAL/.test(id)) return '송장 합계 확인';
  if (/INTERNAL.*WEIGHT|WEIGHT.*INTERNAL/.test(id)) return '총중량·순중량 확인';
  if (/GROSS|WEIGHT/.test(id)) return '화물 중량 비교';
  if (/PACKAGE/.test(id)) return '포장 개수 비교';
  if (/CURRENCY/.test(id)) return '거래 통화 비교';
  if (/STATUS|DRAFT/.test(id)) return '문서 상태 확인';
  if (/DOC_|DOCUMENT_EXIST/.test(id)) return '필수 문서 확인';
  if (/LINK|REFERENCE|^REL_/.test(id)) return '문서 번호 연결 확인';
  if (/PARTIAL|SHIPMENT|TOLERANCE/.test(id)) return '선적 수량·조건 확인';
  const line=/LINE_?(\d+)/.exec(id);
  if(line&&/MODEL|SKU/.test(id)&&/QTY|QUANTITY|PRICE/.test(id))return '품목 '+line[1]+' 정보 비교';
  if (/QUANTITY|QTY/.test(id)) return '품목별 수량 비교';
  if (/PRICE|PRICING/.test(id)) return '품목별 단가 비교';
  if (/MODEL|SKU|LINE_MATCH|LINE_?\d+_MATCH|IDENTITY/.test(id)) return '품목 정보 비교';
  return '서류 내용 비교';
}
function fieldLabel(path) {
  const fields = {po_numbers:'참조 발주서 번호',invoice_numbers:'참조 송장 번호',po_reference:'참조 발주서 번호',invoice_reference:'참조 송장 번호',po_line_reference:'발주서 행 참조',line_number:'품목 행 번호',po_number:'발주서 번호', invoice_number:'송장 번호', packing_list_number:'포장명세서 번호', bl_number:'B/L 번호', quantity:'수량',quantity_raw:'수량 원문', quantity_unit:'수량 단위', unit_price:'단가',unit_price_currency:'단가 통화', sku:'상품 코드(SKU)', model:'모델', currency:'거래 통화',price_basis:'단가 기준', invoice_total:'송장 총액',invoice_total_raw:'총액 원문',gross_weight:'총중량',gross_weight_raw:'총중량 원문',net_weight:'순중량',weight_unit:'중량 단위',total_packages:'포장 개수',package_unit:'포장 단위',document_status:'문서 상태',revision_selection_evidence_raw:'개정·승인 기재 문구',shipment_reference:'선적 참조',partial_shipment_terms:'부분 선적 조건',quantity_tolerance_terms:'수량 허용 조건',shipping_amount_raw:'운임 원문',insurance_amount_raw:'보험료 원문',other_charges_amount_raw:'기타 비용 원문',discount_amount_raw:'할인 원문',tax_amount_raw:'세금 원문'};
  Object.assign(fields,{buyer_name:'구매자',seller_name:'판매자',buyer_address:'구매자 주소',seller_address:'판매자 주소',consignee:'수하인',notify_party:'통지처',port_of_loading:'선적항',port_of_discharge:'양하항'});
  const text = String(path || ''), match = /^items\[(\d+)\]\.(.+)$/.exec(text);
  return match ? '품목 ' + (Number(match[1]) + 1) + ' · ' + (fields[match[2]] || match[2]) : fields[text.replace(/\[\d+\]$/,'')] || text;
}
function rawValue(value, unit) {
  const text = value === '' ? '"" (공란)' : value === null ? 'null (값 없음)' : typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '값 없음') + (unit ? ' ' + unit : '');
}
function documentFor(id) {
  const documents=currentSource?.documents||[],exact=documents.filter(document=>document.document_id===id);
  if(exact.length===1)return exact[0];
  const source=/^([A-Z]+:\d+)(?::items\[\d+\])?$/.exec(String(id)),decorated=/^(.*?) \[([A-Z]+:\d+)\]$/.exec(String(id));
  const key=source?.[1]||decorated?.[2];if(!key)return undefined;
  const matches=documents.filter(document=>document.source_key===key&&(!decorated||document.document_id===decorated[1]));
  return matches.length===1?matches[0]:undefined;
}
function documentCaption(id){
  const doc=documentFor(id);if(!doc)return String(id);
  const item=/:items\[(\d+)\]$/.exec(id);
  return (documentLabel[doc.kind]||doc.kind)+' '+doc.document_id+(item?' · 품목 '+(Number(item[1])+1):'');
}
function makeFinding(check, index) {
  const item = element('details', undefined, 'finding'), title = element('summary');
  title.append(element('span', statusLabel(check.result), 'status-pill ' + statusTone(check.result)), element('strong', friendly(check)));
  const body = element('div', undefined, 'finding-body');
  const detail = element('details',undefined,'inspection-details'); detail.append(element('summary','판단 이유와 비교한 값 '+(check.compared_values||[]).length+'개'),element('p',clean(check.basis)));
  if ((check.compared_values || []).length) {
    const wrap = element('div', undefined, 'value-table'), table = element('table'), thead = element('thead'), head = element('tr');
    for (const name of ['문서', '비교한 항목', '문서에 적힌 값']) head.append(element('th', name));
    thead.append(head); table.append(thead); const tbody = element('tbody');
    for (const value of check.compared_values) {
      const tr = element('tr'), doc = element('td'), source = documentFor(value.document);
      if (source) {
        const jump = element('button', documentLabel[source.kind] || source.kind); jump.type = 'button'; jump.onclick = () => { const ref=refsFor(check).find(ref=>ref.value.document===value.document&&ref.value.field===value.field); if(ref)focusEvidence(check,ref); };
        jump.setAttribute('aria-label', value.document + ' 원문 보기'); doc.append(jump, element('small', value.document));
      } else doc.textContent = value.document;
      const field = element('td', fieldLabel(value.field));
      tr.append(doc, field, element('td', rawValue(value.value, value.unit))); tbody.append(tr);
    }
    table.append(tbody); wrap.append(table); detail.append(wrap);
  }
  const technical = element('details', undefined, 'check-id'); technical.append(element('summary', '검사 ID · 원본 필드 경로'));
  technical.append(element('p', check.check_id));
  for (const value of check.compared_values || []) technical.append(element('p', value.document + ' · ' + value.field));
  detail.append(technical); body.append(detail); item.append(title, body);
  item.open = check === activeCheck || (index === 0 && !activeCheck);
  item.addEventListener('toggle', () => {
    if (item.isConnected && item.open && check !== activeCheck) {
      activateCheck(check);
    }
  });
  return item;
}
function paintChecks() {
  if (!currentRow?.analysis?.result) return;
  const checks = orderedChecks(), attention = checks.filter(check => check.result !== 'PASS');
  $('attentionFilter').textContent = '확인 필요 ' + attention.length;
  $('allFilter').textContent = '전체 검사 ' + checks.length;
  for (const [id, value] of [['attentionFilter','attention'],['allFilter','all']]) {
    $(id).classList.toggle('active', checkFilter === value); $(id).setAttribute('aria-pressed', String(checkFilter === value));
  }
  $('findings').replaceChildren();
  const shown = checkFilter === 'attention' ? attention : checks;
  if (!shown.length) $('findings').append(element('p', '검사 결과에 기록된 불일치나 미완료 항목이 없습니다. 전체 검사에서 비교 근거를 확인할 수 있습니다.', 'empty-findings'));
  else shown.forEach((check, i) => $('findings').append(makeFinding(check, i)));
}
$('attentionFilter').onclick = () => { checkFilter = 'attention'; paintChecks(); };
$('allFilter').onclick = () => { checkFilter = 'all'; paintChecks(); };
function makeResultItem(check,index) {
  const card=element('article',undefined,'result-item '+statusTone(check.result));
  const heading=element('div',undefined,'result-item-heading');
  heading.append(element('span',statusLabel(check.result),'status-pill '+statusTone(check.result)),element('h3',(index+1)+'. '+friendly(check)));
  card.append(heading);
  const model=primaryComparison(check,comparisonModels(check,refsFor(check)));
  if(model)card.append(element('p',comparisonGuide(model).replace('아래 표시된 부분을 함께 확인해 보세요.','원문에서 두 값을 대조해 보세요.').replace('아래에 모았어요.','원문 비교에 모았어요.'),'result-item-summary'));
  const documents=(check.documents||[]).map(documentCaption).join(' · ');
  card.append(element('p',documents,'result-item-documents'));
  const open=element('button','원문 비교 →','button secondary');open.type='button';open.onclick=()=>{
    reviewFilter=check.result==='PASS'?'PASS':'attention';openGuidedReview(check,open);
  };card.append(open);return card;
}
function paintResultItems() {
  const checks=orderedChecks(),attention=checks.filter(check=>check.result!=='PASS'),passed=checks.filter(check=>check.result==='PASS');
  reviewFilter=attention.length?'attention':'all';
  $('resultAttentionList').replaceChildren(...(attention.length?attention:passed).map(makeResultItem));
  $('resultItemsHeading').textContent=attention.length?'확인할 항목 '+attention.length+'개':'검사 결과';
  $('resultPassed').hidden=!attention.length||!passed.length;$('resultPassed').open=false;
  $('resultPassedList').replaceChildren(...(attention.length?passed:[]).map(makeResultItem));
  $('guidedStart').textContent=attention.length?'확인할 항목 따라보기 →':'항목 따라보기 →';
}
function renderResult(row, source) {
  showPage('resultView'); currentRow = row; currentSource = source; activeCheck=null;evidenceRefs=[];comparisonModel=null;compareZoom=false;reviewFilter='all';renderedReviewCheck=null;$('checkInventory').open=false;
  $('newJourneyHost').append($('serviceJourney'));
  document.title='검증 결과 · '+row.filename+' · TradeMatch';
  const result = row.analysis.result, attention = result.checks.filter(check => check.result !== 'PASS');
  $('resultHeading').textContent = row.filename;
  const count = Object.values(result.document_counts).filter(Number.isInteger).reduce((sum, value) => sum + value, 0);
  $('resultMeta').textContent = (row.source === 'saved_config20' ? '과거 저장 기록 · Config 20 · ' : '') + '문서 ' + count + '건 · 검사 ' + result.checks.length + '개 · 결과 저장 ' + dateLabel(row.updated_at);
  const summary=resultSummary(result);
  const needsContext=summary.aggregateNeedsContext;
  $('resultContext').hidden=!needsContext;$('resultContextReasons').replaceChildren();
  $('resultContextMessage').textContent=needsContext?'Studio의 종합 판정은 ‘'+statusLabel(result.status)+'’예요. 항목별 결과와 함께 종합 사유를 확인해 주세요.':'';
  if(needsContext){
    const reasons=result.issues.map(issue=>issue.detail).filter(Boolean);
    for(const reason of reasons.length?reasons:[result.report||'기록된 종합 사유가 없어요. 보고서와 실행 정보를 확인해 주세요.'])$('resultContextReasons').append(element('p',clean(reason)));
  }
  $('decisionBanner').className='decision-banner '+summary.tone;
  $('decisionIcon').textContent=summary.icon;$('decisionTitle').textContent=summary.title;$('decisionSubtitle').textContent=summary.description;$('decisionEnum').textContent=result.status;
  paintResultItems();
  $('checkCount').textContent = '확인 필요 ' + attention.length + '개';
  const findings = row.analysis.evidence_audit?.findings || [], technical = row.analysis.technical_issues || [];
  $('technicalNotice').hidden = !findings.length && !technical.length;
  $('technicalNotice').textContent = '결과 전달 또는 근거 확인이 필요한 항목이 있습니다. ' + [...technical, findings.length ? '원문 추출값과 근거 경로 점검 ' + findings.length + '건.' : ''].filter(Boolean).join(' ');
  checkFilter = attention.length ? 'attention' : 'all'; activateCheck(reviewDeck()[0]); paintChecks();
  $('issuesSection').hidden = !result.issues.length; $('issuesSection').open = false; $('issuesTitle').textContent = '판정에 기록된 사유 ' + result.issues.length + '개'; $('issuesList').replaceChildren();
  for (const issue of result.issues) $('issuesList').append(element('article', clean(issue.detail)));
  $('reportDownload').href = '/api/runs/' + row.id + '/report.html'; $('rawDownload').href = '/api/runs/' + row.id + '/raw';
  $('provenanceDetails').replaceChildren();
  for (const [name, value] of [['판정 노드', row.analysis.decision_node],['실제 결정값', row.analysis.decision_value],['실행 분기', row.analysis.executed_branch],['Job ID', row.job_id],['실행 버전', row.settings_snapshot?.config_version],['기록 출처', row.source === 'saved_config20' ? '과거 Config 20 저장 기록' : 'Studio API 실행 결과']]) metadataPair($('provenanceDetails'), name, value);
  if(row.upload_filename)metadataPair($('provenanceDetails'),'Studio 업로드 파일명',row.upload_filename);
  $('studioNarrative').textContent = clean(result.report || ''); $('studioNarrative').hidden = !result.report;
  $('resultHeading').focus({preventScroll:true});
}
function openReport() {
  const result=currentRow?.analysis?.result;
  if(!result||$('resultView').hidden||$('reportDialog').open)return;
  const body=$('reportBody');body.replaceChildren();
  $('reportHeading').textContent=currentRow.filename;
  $('reportDate').textContent='결과 저장 '+dateLabel(currentRow.updated_at)+' · 검사 '+result.checks.length+'개';
  const overview=element('section',undefined,'report-card report-overview');
  overview.append(element('p','Studio 종합 판정','eyebrow'),element('h3',statusLabel(result.status),'report-verdict '+statusTone(result.status)));
  const counts=element('div',undefined,'report-counts');
  for(const status of ['FAIL','REQUIRES_HUMAN_REVIEW','PASS']){
    const count=result.checks.filter(check=>check.result===status).length;
    const item=element('div',undefined,statusTone(status));
    item.append(element('span',statusLabel(status)),element('strong',count+'건'));counts.append(item);
  }
  overview.append(counts);body.append(overview);
  if(result.report){
    const narrative=element('section',undefined,'report-card');
    narrative.append(element('h3','종합 설명'),element('p',clean(result.report),'report-narrative'));body.append(narrative);
  }
  if(result.issues.length){
    const issues=element('section',undefined,'report-card');issues.append(element('h3','확인이 필요한 이유'));
    const list=element('ul');for(const issue of result.issues)list.append(element('li',clean(issue.detail)));issues.append(list);body.append(issues);
  }
  const checks=element('section',undefined,'report-checks');checks.append(element('h3','항목별 검사 근거'),element('p','불일치부터 살펴보세요. 카드를 펼치면 판단 이유와 실제 비교값을 볼 수 있어요.','report-help'));
  for(const check of orderedChecks()){
    const card=element('details',undefined,'report-check report-card '+statusTone(check.result));
    const heading=element('summary');heading.append(element('span',statusLabel(check.result),'status-pill '+statusTone(check.result)),element('strong',friendly(check)));card.append(heading);
    const content=element('div',undefined,'report-check-content');content.append(element('p',clean(check.basis||'기록된 판단 이유가 없어요.'),'report-narrative'));
    if(check.compared_values?.length){
      const scroll=element('div',undefined,'report-table-scroll'),table=element('table');
      const head=element('thead'),headRow=element('tr');
      for(const label of ['문서','비교 항목','기록된 값','단위']){const cell=element('th',label);cell.scope='col';headRow.append(cell);}head.append(headRow);table.append(head);
      const rows=element('tbody');
      for(const value of check.compared_values){
        const row=element('tr');for(const text of [value.document,fieldLabel(value.field),JSON.stringify(value.value),value.unit||'—'])row.append(element('td',String(text??'—')));rows.append(row);
      }
      table.append(rows);scroll.append(table);content.append(scroll);
    }
    const source=element('button','원문에서 확인 →','button secondary');source.type='button';source.onclick=()=>{
      closeReport(false);reviewFilter='all';activateCheck(check);if(check.result==='PASS')checkFilter='all';paintChecks();focusReviewCard();
    };content.append(source);
    const info=element('p',check.check_id,'report-check-id');content.append(info);card.append(content);checks.append(card);
  }
  body.append(checks);
  const technical=element('details',undefined,'report-card report-technical');technical.append(element('summary','실행 정보 보기'));
  const metadata=element('dl');for(const [name,value] of [['실제 결정값',currentRow.analysis.decision_value],['실행 분기',currentRow.analysis.executed_branch],['Job ID',currentRow.job_id],['Config',currentRow.settings_snapshot?.config_version]])metadataPair(metadata,name,value);
  technical.append(metadata);body.append(technical);
  document.body.classList.add('report-open');$('reportDialog').showModal();body.scrollTop=0;$('reportHeading').focus({preventScroll:true});
}
function closeReport(restoreFocus=true) {
  if(!$('reportDialog').open)return;
  document.body.classList.remove('report-open');$('reportDialog').close();
  if(restoreFocus&&!$('resultView').hidden)$('reportOpen').focus({preventScroll:true});
}
$('reportOpen').onclick=openReport;
$('reportClose').onclick=()=>closeReport();
$('reportDialog').addEventListener('cancel',event=>{event.preventDefault();closeReport();});
$('reportDialog').addEventListener('close',()=>document.body.classList.remove('report-open'));
function resultSummary(result) {
  const failed=result.checks.filter(check=>check.result==='FAIL').length,review=result.checks.filter(check=>check.result==='REQUIRES_HUMAN_REVIEW').length,passed=result.checks.filter(check=>check.result==='PASS').length;
  const aggregateNeedsContext=result.status==='REQUIRES_HUMAN_REVIEW'?review===0:result.status==='FAIL'?failed===0:failed>0||review>0;
  const unresolved=failed===0&&review===0&&aggregateNeedsContext;
  let title=failed?'불일치 '+failed+'건 확인'+(review?' · 검토 필요 '+review+'건':''):review?'검토 필요 '+review+'건':unresolved?'종합 판정 확인이 필요합니다.':'비교한 항목이 모두 일치해요.';
  if(aggregateNeedsContext&&!unresolved)title+=' · 종합 판정 확인 필요';
  const tone=failed?'fail':review||aggregateNeedsContext?'review':'pass',icon=failed?'≠':review||aggregateNeedsContext?'?':'✓';
  const description=(failed||review?'아래 '+(failed+review)+'개 항목을 확인해 주세요.':unresolved?'보고서에서 종합 판정의 근거를 확인해 주세요.':'제공한 문서 범위에서 비교를 마쳤어요.')+(aggregateNeedsContext?' 종합 판정 사유도 보고서에서 확인해 주세요.':'');
  return {failed,review,passed,title,tone,icon,description,aggregateNeedsContext};
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '날짜 미확인' : date.toLocaleString('ko-KR', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
async function refreshHistory(token = routeToken) {
  $('runHistory').setAttribute('aria-busy','true');if(!historyRows.length)$('historyCount').textContent='기록을 불러오고 있어요…';
  try {
    const data = await api('/api/runs');
    if (token !== routeToken) return;
    historyRows=data.runs.filter(row=>row.source!=='saved_config20');paintHistory(true);
  } catch(error){
    if(token===routeToken&&!historyRows.length)$('historyCount').textContent='기록을 불러오지 못했어요. 새로고침해 주세요.';
    throw error;
  } finally { if(token===routeToken)$('runHistory').setAttribute('aria-busy','false'); }
}
function historyCategory(row) {
  if(activePhases.has(row.phase))return 'active';
  if(row.phase!=='completed')return 'unfinished';
  return ['PASS','FAIL','REQUIRES_HUMAN_REVIEW'].includes(row.studio_status)?row.studio_status:'unknown';
}
function paintHistory(animate=false) {
  $('runHistory').classList.toggle('history-arriving',animate===true);
  const query=$('historySearch').value.trim().normalize('NFC').toLocaleLowerCase('ko-KR'),status=$('historyStatus').value;
  const filtered=Boolean(query||status!=='all');
  const rows=historyRows.filter(row=>(!query||String(row.filename||'').normalize('NFC').toLocaleLowerCase('ko-KR').includes(query))&&(status==='all'||historyCategory(row)===status));
  $('clearHistoryFilters').hidden=!filtered;
  $('historyCount').textContent=filtered?'전체 '+historyRows.length+'건 중 '+rows.length+'건':'전체 '+rows.length+'건';
  $('runHistory').replaceChildren();
  if (!historyRows.length) {
    const empty = element('div', undefined, 'history-empty'); empty.append(element('h2', '아직 올린 문서가 없어요.'), element('p', 'PDF를 올리면 문서를 함께 확인해 드려요.'));
    const link = element('a', '새 검증 시작', 'button primary'); link.href = '/?view=new'; link.dataset.route = ''; empty.append(link); $('runHistory').append(empty); return;
  }
  if(!rows.length){
    const empty=element('div',undefined,'history-empty');empty.append(element('h2','찾으시는 기록이 없어요.'),element('p','파일 이름이나 상태를 바꿔보세요. 검색 지우기를 누르면 전체 기록을 볼 수 있어요.'));$('runHistory').append(empty);return;
  }
  for (const [index,row] of rows.entries()) {
    const link = element('a', undefined, 'history-row'); link.href = '/?run=' + row.id; link.dataset.route = '';
    link.style.setProperty('--row-order',String(Math.min(index,5)));
    link.classList.toggle('is-processing',historyCategory(row)==='active');
    const info = element('div'); info.append(element('strong', row.filename), element('small', '접수 '+dateLabel(row.created_at) + (row.settings_snapshot?.config_version ? ' · 검증 버전 ' + row.settings_snapshot.config_version : '')));
    const verdict = row.phase === 'completed' ? row.studio_status : null;
    link.append(info, element('span', verdict ? statusLabel(verdict) : row.phase === 'completed' ? '결과 확인 필요' : phaseLabel[row.phase] || row.phase, 'status-pill ' + statusTone(verdict)), element('span', '→', 'row-arrow'));
    $('runHistory').append(link);
  }
}
$('historySearch').addEventListener('input',paintHistory);
$('historyStatus').addEventListener('change',paintHistory);
$('clearHistoryFilters').addEventListener('click',()=>{$('historySearch').value='';$('historyStatus').value='all';paintHistory();$('historySearch').focus();});
$('refreshHistory').onclick = async () => {
  $('refreshHistory').disabled = true;notice();
  try { await refreshHistory(); } catch (error) { notice(error.message); }
  finally { $('refreshHistory').disabled = false; }
};
function openConnection() {
  const settings = connection.settings || {};
  $('agentInput').value = settings.agent_id || ''; $('projectInput').value = settings.project_id || 'proj_e88CHrANRG3JeEdUgt95vf';
  $('configInput').value = settings.config_version || ''; $('decisionInput').value = settings.decision_node || '';
  const locked=Boolean(connection.settings_locked);
  for(const id of ['agentInput','projectInput','configInput','decisionInput'])$(id).readOnly=locked;
  $('saveConnection').hidden=locked;$('connectionAdvanced').hidden=locked;
  $('connectionHeading').textContent=locked?'현재 검증 환경':'검증 환경 연결';
  $('connectionDescription').textContent=locked?'관리자가 지정한 워크플로우로 문서를 확인해요. 환경 변경은 서버에서 관리합니다.':'Studio에 저장된 워크플로우를 연결해요. 바꾼 설정은 다음 검증부터 적용돼요.';
  $('keyState').textContent = locked?'검증 환경이 서버에 연결되어 있어요. PDF를 등록해 검증을 시작하세요.': connection.key_available ? 'API 키가 서버에 연결되어 있습니다. 키를 다시 입력할 필요가 없습니다.' : 'API 키가 아직 연결되지 않았습니다.\n프로젝트 폴더의 TradeMatch_실행.command를 열어 키를 입력하세요. 새로 열리는 서비스 화면을 사용하면 됩니다. 키는 이 화면에 입력하거나 파일에 저장하지 않습니다.';
  $('connectionError').textContent = ''; $('connectionDialog').showModal();
}
$('connectOpen').onclick = openConnection; $('connectSecond').onclick = openConnection; $('connectClose').onclick = () => $('connectionDialog').close();
$('connectionForm').onsubmit = async event => {
  event.preventDefault();if(connection.settings_locked){$('connectionError').textContent='배포 환경은 서버에서 관리합니다.';return;} $('saveConnection').disabled = true;
  try {
    await post('/api/settings', {agent_id:$('agentInput').value.trim(),project_id:$('projectInput').value.trim(),config_version:Number($('configInput').value),decision_node:$('decisionInput').value.trim()});
    await refreshConnection(); $('connectionDialog').close(); if(!$('newView').hidden&&connection.can_execute)paintTimeEstimate({settings_snapshot:connection.settings,job_id:null},routeToken);
    if (connection.can_execute) notice(pickedFile ? '연결했습니다. 선택한 PDF로 검증 시작을 누르세요.' : '연결했습니다. PDF를 선택해 검증을 시작하세요.');
    else notice('워크플로우 설정을 저장했습니다. 실행 파일에서 API 키를 연결해주세요.');
  } catch (error) { $('connectionError').textContent = error.message; }
  finally { $('saveConnection').disabled = false; }
};
// Local-only free throw: the preview and the shot share the same physics.
const PDF_COURT={width:900,height:480,gravity:900,rimX:704,rimY:190,rimHalf:42,radius:11,homeX:210,homeY:370};
function freeThrowStep(ball,dt){
  const c=PDF_COURT,oldX=ball.x,oldY=ball.y;
  ball.x+=ball.vx*dt;ball.y+=ball.vy*dt+c.gravity*dt*dt/2;ball.vy+=c.gravity*dt;ball.age=(ball.age||0)+dt;
  if(!ball.scored&&oldY<c.rimY&&ball.y>=c.rimY&&ball.vy>0){
    const x=oldX+(ball.x-oldX)*(c.rimY-oldY)/(ball.y-oldY);
    if(x>c.rimX-c.rimHalf+c.radius&&x<c.rimX+c.rimHalf-c.radius){ball.scored=true;ball.x=x;ball.vx*=.12;return 'goal';}
  }
  if(!ball.scored){
    if(ball.x+c.radius>758&&oldX+c.radius<=758&&ball.y>72&&ball.y<210){ball.x=758-c.radius;ball.vx=-Math.abs(ball.vx)*.64;}
    for(const rim of [c.rimX-c.rimHalf,c.rimX+c.rimHalf]){
      const dx=ball.x-rim,dy=ball.y-c.rimY,d=Math.hypot(dx,dy),radius=c.radius+4;
      if(d>0&&d<radius){const nx=dx/d,ny=dy/d,dot=ball.vx*nx+ball.vy*ny;if(dot<0){ball.vx-=1.65*dot*nx;ball.vy-=1.65*dot*ny;}ball.x=rim+nx*radius;ball.y=c.rimY+ny*radius;}
    }
  }
  return ball.y>452||ball.x>950||ball.x< -50||ball.age>3.5?'end':null;
}
function freeThrowPreview(ball){
  const copy={...ball},points=[{x:copy.x,y:copy.y}];
  for(let i=0;i<78;i++){const event=freeThrowStep(copy,1/45);if(i%3===0)points.push({x:copy.x,y:copy.y});if(event==='goal'||event==='end')break;}
  return points;
}
function createFreeThrowGame(){
  const c=PDF_COURT,labels=['CI','BL','PO','PL'],colors={CI:'#3159d9',BL:'#356f8a',PO:'#7661ad',PL:'#b87829'};
  const stage=$('hoopStage'),svg=$('hoopSvg');
  let run=null,phase='ready',last=null,frame=0,ball=null,drag=null,score=0,streak=0,best=0,attempts=0,label='',resultTime=0,pausedPhase='ready',particles=[];
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  try{const value=Number(localStorage.getItem('tradematch.pdf-hoop-best'));if(Number.isInteger(value)&&value>=0&&value<100000)best=value;}catch{}
  function paper(){
    const group=$('hoopMoving');group.replaceChildren();
    group.append(svgElement('path',{d:'M -26 -33 H 12 L 27 -18 V 33 H -26 Z',fill:'white',stroke:colors[label],'stroke-width':2}));
    group.append(svgElement('path',{d:'M 12 -33 V -18 H 27',fill:'#e8edf9',stroke:colors[label],'stroke-width':1.5}));
    group.append(svgElement('rect',{x:-20,y:-8,width:40,height:24,rx:5,fill:colors[label]}));
    const name=svgElement('text',{x:0,y:9,'text-anchor':'middle',fill:'white','font-size':16,'font-weight':750});name.textContent=label;group.append(name);
    group.append(svgElement('path',{d:'M -17 23 H 17',stroke:'#d9e1ef','stroke-width':2}));
    $('hoopDocumentName').textContent=label+'.pdf';group.setAttribute('aria-label',label+' PDF 잡아서 던지기');
  }
  function paint(){
    if(!ball)return;
    const angle=phase==='flight'||phase==='celebrating'?Math.max(-45,Math.min(45,ball.vx*.05))*(ball.scored ? 0.3 : 1):drag?(ball.x-c.homeX)*.08:-7;
    const scale=ball.scored ? 0.83 : 1;
    $('hoopMoving').setAttribute('transform',`translate(${ball.x} ${ball.y}) rotate(${angle}) scale(${scale})`);
    $('hoopShadow').setAttribute('cx',ball.x);$('hoopShadow').setAttribute('rx',Math.max(9,26-(430-ball.y)*.025));
    $('hoopScore').textContent=score;$('hoopStreak').textContent=streak;$('hoopBest').textContent=best;$('hoopAttempts').textContent=attempts+'회 시도';
  }
  function controls(){
    $('hoopGame').dataset.phase=phase;
    $('hoopOverlay').hidden=phase!=='paused';$('hoopPause').hidden=phase==='paused';
    $('hoopAction').disabled=['flight','celebrating','missed','aiming'].includes(phase);
    $('hoopAction').textContent=phase==='paused'?'계속하기':'연습 슛  Space';
    stage.setAttribute('aria-label',phase==='paused'?'일시 정지된 PDF 자유투':label+' PDF를 잡아 던지세요. 스페이스바로 연습 슛');
  }
  function newPaper(){
    label=labels.filter(name=>name!==label)[Math.floor(Math.random()*(label?3:4))]||'CI';
    ball={x:c.homeX,y:c.homeY,vx:0,vy:0,age:0,scored:false};drag=null;phase='ready';resultTime=0;
    $('hoopTrail').setAttribute('d','');$('hoopBurst').setAttribute('opacity',0);$('hoopConfetti').replaceChildren();$('hoopNet').removeAttribute('transform');
    particles=[];paper();controls();paint();
  }
  function schedule(){cancelAnimationFrame(frame);last=null;frame=requestAnimationFrame(tick);}
  function celebrate(){
    score++;streak++;if(streak>best){best=streak;try{localStorage.setItem('tradematch.pdf-hoop-best',String(best));}catch{}}
    phase='celebrating';resultTime=0;$('hoopBurstTitle').textContent=streak>1?streak+'연속 골인!':label+' 골인!';
    $('hoopMessage').textContent='골인! '+label+'.pdf가 쏙 들어갔어요. '+(streak>1?streak+'번 연속 성공!':'다음 PDF도 도전해 보세요.');
    $('hoopBurst').setAttribute('opacity',1);$('hoopTrail').setAttribute('d','');
    if(!reduced)for(let i=0;i<34;i++){
      const node=svgElement('rect',{width:5,height:9,rx:1,fill:['#3159d9','#e9b64c','#40a68b','#a091dc'][i%4]});
      $('hoopConfetti').append(node);particles.push({node,x:c.rimX,y:c.rimY-12,vx:(Math.random()-.5)*370,vy:-130-Math.random()*260,rotation:Math.random()*180});
    }
    controls();paint();
  }
  function tick(time){
    if(!['flight','celebrating','missed'].includes(phase))return;
    if(document.hidden){pause();return;}
    const dt=last===null?0:Math.min(.035,Math.max(0,(time-last)/1000));last=time;
    if(phase==='flight'){
      const event=freeThrowStep(ball,dt);
      if(event==='goal')celebrate();else if(event==='end'){phase='missed';resultTime=0;streak=0;$('hoopMessage').textContent='아깝다! 점선을 보며 방향과 힘을 조금 바꿔보세요.';controls();}
    }else if(phase==='celebrating'){
      resultTime+=dt;freeThrowStep(ball,dt);
      $('hoopNet').setAttribute('transform','translate(0 '+(reduced?0:Math.sin(resultTime*27)*Math.max(0,1-resultTime)*5)+')');
      $('hoopBurst').setAttribute('opacity',Math.min(1,(1.3-resultTime)*3));
      for(const p of particles){p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=600*dt;p.rotation+=170*dt;p.node.setAttribute('transform',`translate(${p.x} ${p.y}) rotate(${p.rotation})`);p.node.setAttribute('opacity',Math.max(0,1-resultTime/1.25));}
      if(resultTime>1.3)newPaper();
    }else{resultTime+=dt;if(resultTime>.75)newPaper();}
    paint();if(['flight','celebrating','missed'].includes(phase))frame=requestAnimationFrame(tick);
  }
  function point(event){
    if(svg.createSVGPoint&&svg.getScreenCTM){const matrix=svg.getScreenCTM();if(matrix){const p=svg.createSVGPoint();p.x=event.clientX;p.y=event.clientY;return p.matrixTransform(matrix.inverse());}}
    const r=svg.getBoundingClientRect();return {x:(event.clientX-r.left)*900/(r.width||900),y:(event.clientY-r.top)*480/(r.height||480)};
  }
  function aimed(event){
    const p=point(event),dx=p.x-drag.start.x,dy=p.y-drag.start.y;
    return {x:Math.max(42,Math.min(550,c.homeX+dx)),y:Math.max(80,Math.min(420,c.homeY+dy)),vx:Math.max(-850,Math.min(850,dx*3)),vy:Math.max(-1100,Math.min(700,dy*3)),age:0,scored:false};
  }
  function showAim(){
    const points=freeThrowPreview(ball);$('hoopTrail').setAttribute('d',points.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' '));
  }
  function shoot(){
    if(Math.hypot(ball.vx,ball.vy)<85){phase='ready';ball={x:c.homeX,y:c.homeY,vx:0,vy:0};$('hoopTrail').setAttribute('d','');$('hoopMessage').textContent='PDF를 골대 쪽으로 조금 더 끌었다가 놓아보세요.';controls();paint();return;}
    phase='flight';attempts++;$('hoopTrail').setAttribute('d','');$('hoopMessage').textContent=label+'.pdf가 날아갑니다!';controls();schedule();
  }
  stage.addEventListener('pointerdown',event=>{
    if(phase!=='ready'||event.button>0||event.isPrimary===false||document.hidden)return;
    const p=point(event);if(Math.hypot(p.x-ball.x,p.y-ball.y)>65)return;
    event.preventDefault();drag={pointer:event.pointerId,start:p};phase='aiming';stage.setPointerCapture?.(event.pointerId);controls();
  });
  stage.addEventListener('pointermove',event=>{
    if(phase!=='aiming'||event.pointerId!==drag?.pointer)return;
    event.preventDefault();ball=aimed(event);showAim();paint();
  });
  stage.addEventListener('pointerup',event=>{
    if(phase!=='aiming'||event.pointerId!==drag?.pointer)return;
    event.preventDefault();ball=aimed(event);drag=null;stage.releasePointerCapture?.(event.pointerId);shoot();
  });
  function cancelAim(event){if(phase==='aiming'&&drag&&event.pointerId===drag.pointer){drag=null;newPaper();}}
  stage.addEventListener('pointercancel',cancelAim);stage.addEventListener('lostpointercapture',cancelAim);
  function practice(){
    if(document.hidden)return;
    if(phase==='paused'){phase=pausedPhase;controls();if(['flight','celebrating','missed'].includes(phase))schedule();return;}
    if(phase!=='ready')return;
    const t=1.15;ball={x:c.homeX,y:c.homeY,vx:(c.rimX-c.homeX)/t,vy:(c.rimY-c.homeY-c.gravity*t*t/2)/t,age:0,scored:false};shoot();stage.focus({preventScroll:true});
  }
  function pause(){
    if(phase==='paused')return;
    if(phase==='aiming'){drag=null;newPaper();}
    pausedPhase=phase;phase='paused';cancelAnimationFrame(frame);last=null;controls();
  }
  stage.addEventListener('keydown',event=>{if((event.key===' '||event.key==='Enter')&&!event.repeat){event.preventDefault();practice();}});
  $('hoopAction').onclick=practice;$('hoopPause').onclick=pause;
  $('hoopReset').onclick=()=>{cancelAnimationFrame(frame);score=0;streak=0;attempts=0;newPaper();$('hoopMessage').textContent='새 판이에요. PDF를 잡아 던져보세요.';};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  newPaper();
  return {attach(id){if(run!==id){run=id;cancelAnimationFrame(frame);score=0;streak=0;attempts=0;newPaper();}},pause};
}
const hoopGame=createFreeThrowGame();
function mountHoopGame(id,host){if($('hoopGame').parentElement!==$(host))$(host).append($('hoopGame'));$('hoopGame').hidden=false;hoopGame.attach(id);}

// Display only topology and node names from Studio exports; never prompts or credentials.
function parseWorkflowDiagram(input) {
  const config=input?.workflowConfig||input;
  if(!Array.isArray(config?.pipelineEdges)||!config.pipelineEdges.length)throw Error('Studio에서 내보낸 워크플로우 JSON의 pipelineEdges를 찾지 못했어요.');
  if(config.pipelineEdges.length>300)throw Error('연결선이 너무 많아 간단한 구조도로 표시하기 어려워요.');
  const nodes=new Map(),types={parse:'Parse',classify:'Classify / Split',extract:'Extract',merge:'Merge',instruct:'Instruct'};
  const add=endpoint=>{
    if(!endpoint||typeof endpoint.nodeType!=='string')throw Error('노드 연결 정보의 형식을 확인해 주세요.');
    const type=endpoint.nodeType,name=typeof endpoint.name==='string'?endpoint.name:'';
    const id=['parse','classify'].includes(type)?type:type+':'+name;
    if(!nodes.has(id))nodes.set(id,{id,type,label:name||(type==='parse'?config.documentParseConfiguration?.customName:type==='classify'?config.documentClassifyConfiguration?.customName:null)||types[type]||type});
    return id;
  };
  const edges=config.pipelineEdges.map(edge=>({source:add(edge.source),target:add(edge.target),label:typeof edge.condition?.conditionName==='string'?edge.condition.conditionName:''}));
  for(const node of config.instructConfiguration?.nodes||[])if(typeof node.name==='string')add({nodeType:'instruct',name:node.name});
  for(const schema of config.informationExtractConfiguration?.schemas||[])if(typeof schema.json_schema?.name==='string')add({nodeType:'extract',name:schema.json_schema.name});
  if(nodes.size>100)throw Error('노드가 너무 많아 간단한 구조도로 표시하기 어려워요.');
  const degree=new Map([...nodes.keys()].map(id=>[id,0])),levels=new Map([...nodes.keys()].map(id=>[id,0]));
  edges.forEach(edge=>degree.set(edge.target,degree.get(edge.target)+1));
  const queue=[...nodes.keys()].filter(id=>degree.get(id)===0);let visited=0;
  for(let i=0;i<queue.length;i++){
    const id=queue[i];visited++;
    for(const edge of edges.filter(edge=>edge.source===id)){
      levels.set(edge.target,Math.max(levels.get(edge.target),levels.get(id)+1));degree.set(edge.target,degree.get(edge.target)-1);
      if(!degree.get(edge.target))queue.push(edge.target);
    }
  }
  if(visited!==nodes.size)throw Error('순환 연결이 있어 구조도를 배치하지 못했어요. 원본 워크플로우 연결을 확인해 주세요.');
  const columns=new Map();for(const node of nodes.values()){
    const column=levels.get(node.id);if(!columns.has(column))columns.set(column,[]);columns.get(column).push(node);
  }
  const maxRows=Math.max(...[...columns.values()].map(column=>column.length));
  for(const [column,items]of columns)items.forEach((node,row)=>{
    node.column=column;node.x=18+column*180;node.y=56+(maxRows-items.length)*34+row*68;
  });
  return {name:String(config.workflow_name||'선택한 워크플로우'),nodes:[...nodes.values()],edges,nodeWidth:148,nodeHeight:54,width:Math.max(...[...nodes.values()].map(node=>node.x))+166,height:Math.max(...[...nodes.values()].map(node=>node.y))+72};
}
function workflowNodeTitle(node){
  const names={문서_연결_확인:'문서 연결 확인',PO_CI_상업검증:'발주·송장 비교',CI_PL_BL_물류검증:'선적 정보 비교',최종판정:'최종 판정',검증완료_요약:'일치 요약',불일치_조치초안:'불일치 조치',담당자_검토요청:'검토 요청',OTHER_extract_schema:'기타 문서 처리'};
  if(names[node.label])return names[node.label];
  if(node.type==='parse')return '문서 읽기';if(node.type==='classify')return '문서 분류';if(node.type==='merge')return '추출 결과 모으기';
  if(node.type==='extract')return ({PO:'발주서',CI:'상업송장',PL:'포장명세서',BL:'선하증권'}[node.label.split('_')[0]]||node.label.split('_')[0])+' 추출';
  return node.label.replace(/_/g,' ');
}
function renderWorkflowDiagram(model) {
  const svg=svgElement('svg',{viewBox:'0 0 '+model.width+' '+model.height,width:model.width,height:model.height,role:'img','aria-label':model.name+' · 노드 '+model.nodes.length+'개, 연결 '+model.edges.length+'개'});
  const defs=svgElement('defs'),marker=svgElement('marker',{id:'workflowArrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto'});marker.append(svgElement('path',{d:'M 0 0 L 10 5 L 0 10 z',class:'workflow-arrow'}));defs.append(marker);svg.append(defs);
  const nodes=new Map(model.nodes.map(node=>[node.id,node]));
  const linking=model.nodes.find(node=>node.label==='문서_연결_확인'),decision=model.nodes.find(node=>node.label==='최종판정');
  if(linking&&decision){
    const groups=[{start:0,end:linking.column-1,label:'01  문서 읽기·추출'},{start:linking.column,end:decision.column-1,label:'02  문서 연결·비교'},{start:decision.column,end:Math.max(...model.nodes.map(n=>n.column)),label:'03  판정·안내'}];
    for(const group of groups){
      const x=10+group.start*180,width=(group.end-group.start)*180+164;
      svg.append(svgElement('rect',{x,y:35,width,height:model.height-43,rx:8,class:'workflow-stage'}));
      const label=svgElement('text',{x:x+8,y:22,class:'workflow-stage-label'});label.textContent=group.label;svg.append(label);
    }
  }
  for(const edge of model.edges){
    const from=nodes.get(edge.source),to=nodes.get(edge.target),x=from.x+model.nodeWidth,y=from.y+model.nodeHeight/2,tx=to.x,ty=to.y+model.nodeHeight/2,middle=(x+tx)/2;
    svg.append(svgElement('path',{d:`M ${x} ${y} C ${middle} ${y}, ${middle} ${ty}, ${tx-3} ${ty}`,class:'workflow-edge','marker-end':'url(#workflowArrow)'}));
    if(edge.label){const label=svgElement('text',{x:tx-5,y:ty-7,class:'workflow-edge-label','text-anchor':'end'});label.textContent=({PASS:'일치',FAIL:'불일치',REQUIRES_HUMAN_REVIEW:'확인 필요',others:'기타'})[edge.label]||edge.label;svg.append(label);}
  }
  for(const node of model.nodes){
    const tone=({검증완료_요약:'pass',불일치_조치초안:'fail',담당자_검토요청:'review'})[node.label]||'normal';
    const group=svgElement('g',{transform:`translate(${node.x} ${node.y})`,'data-tone':tone}),title=svgElement('title');title.textContent=node.label+' · '+node.type;group.append(title,svgElement('rect',{width:model.nodeWidth,height:model.nodeHeight,rx:6,class:'workflow-node'}));
    const label=svgElement('text',{x:11,y:23,class:'workflow-node-label'}),name=Array.from(workflowNodeTitle(node));label.textContent=name.slice(0,12).join('')+(name.length>12?'…':'');group.append(label);
    const type=svgElement('text',{x:11,y:41,class:'workflow-type'});type.textContent=node.type==='extract'?node.label.split('_')[0]+' · Extract':({parse:'Parse',classify:'Classify / Split',merge:'Merge'})[node.type]||'Instruct';group.append(type);svg.append(group);
  }
  $('workflowMap').replaceChildren(svg);$('workflowMap').hidden=false;
}
function loadPublishedWorkflow(){
  const data=$('publishedWorkflow');if(!data)return;
  try{
    const published=JSON.parse(data.textContent),model=parseWorkflowDiagram(published);
    renderWorkflowDiagram(model);
    $('workflowMapStatus').textContent='Config '+published.config_version+' · 노드 '+model.nodes.length+'개 · 연결 '+model.edges.length+'개 · Studio Export 기준';
  }catch{$('workflowMapStatus').textContent='워크플로우 구조도를 불러오지 못했어요. Export 파일로 확인해 주세요.';}
}
loadPublishedWorkflow();
const workflowReturnPoint=$('workflowMap').parentElement;
function closeWorkflow(restoreFocus=true){
  if($('workflowDialog').open)$('workflowDialog').close();
  if($('workflowMap').parentElement!==workflowReturnPoint)$('workflowMapStatus').after($('workflowMap'));
  document.body.classList.remove('workflow-open');if(restoreFocus)$('workflowExpand').focus({preventScroll:true});
}
$('workflowExpand').onclick=()=>{
  $('workflowDialogHost').append($('workflowMap'));document.body.classList.add('workflow-open');
  $('workflowDialog').showModal();$('workflowMap').focus({preventScroll:true});
};
$('workflowClose').onclick=closeWorkflow;
$('workflowDialog').addEventListener('cancel',event=>{event.preventDefault();closeWorkflow();});
$('workflowDialog').addEventListener('close',()=>{if(document.body.classList.contains('workflow-open'))closeWorkflow();});
$('workflowJson').addEventListener('change',async()=>{
  const file=$('workflowJson').files[0];if(!file)return;
  $('workflowMap').replaceChildren();$('workflowMap').hidden=true;
  try{
    if(file.size>5*1024*1024)throw Error('5 MB 이하의 워크플로우 JSON을 선택해 주세요.');
    const text=await file.text();if($('workflowJson').files[0]!==file)return;
    const model=parseWorkflowDiagram(JSON.parse(text));renderWorkflowDiagram(model);
    $('workflowMapStatus').textContent=file.name+' · 노드 '+model.nodes.length+'개 · 연결 '+model.edges.length+'개 · 옆으로 밀어 전체 구조를 확인하세요.';
  }catch(error){$('workflowMapStatus').textContent=error instanceof SyntaxError?'JSON 파일 내용을 읽지 못했어요. 올바른 Export 파일인지 확인해 주세요.':error.message;}
});
const motionSections=[...document.querySelectorAll('.about-workflow,.about-contribution')];
if(typeof IntersectionObserver==='function'){
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('flow-visible');observer.unobserve(entry.target);}},{threshold:.12});
  for(const section of motionSections)observer.observe(section);
}else for(const section of motionSections)section.classList.add('flow-visible');
document.addEventListener('visibilitychange',()=>document.documentElement.classList.toggle('motion-suspended',document.hidden));
(async () => {
  try { await refreshConnection(); await renderRoute(); }
  catch (error) { notice('서비스 연결을 확인해주세요. ' + error.message); updateFile(); }
})();
