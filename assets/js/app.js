(() => {
  "use strict";

  /* AUTOSHIFT v44
     - 業務 × 勤務パターンの必要条件を独立して保持
     - スタッフ／業務／勤務パターンを追加・削除可能
     - サンプルシフトをシフト作成画面から呼び出し可能
     - 自動作成は「必要枠」を直接生成し、業務条件を0なら制約にしない
  */
  const STORAGE_KEY = "autoshift_v44";
  const CURRENT_VIEW_KEY = "autoshift_current_view_v44";
  const INITIAL_VIEW = "home";
  const STATE_VERSION = 44;
  const DAYS = ["月","火","水","木","金","土","日"];
  const HARD_TYPES = new Set(["shortage","over","job","duplicate","skill","condition","config"]);

  const uid = (p="id") => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const clone = v => JSON.parse(JSON.stringify(v));
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
  const toMin = t => { const [h,m] = String(t||"00:00").split(":").map(Number); return h*60+m; };
  const daysInMonth = month => { const [y,m]=month.split("-").map(Number); return new Date(y,m,0).getDate(); };
  const dateKey = (month,day) => `${month}-${String(day).padStart(2,"0")}`;
  const jpDay = (month,day) => { const [y,m]=month.split("-").map(Number); const d=new Date(y,m-1,day).getDay(); return DAYS[(d+6)%7]; };
  const weekdayIndex = (month,day) => DAYS.indexOf(jpDay(month,day));
  const overlap = (a,b) => toMin(a.start)<toMin(b.end) && toMin(b.start)<toMin(a.end);
  const canWork = (s,p) => toMin(s.start)<=toMin(p.start) && toMin(s.end)>=toMin(p.end);
  const monthNow = () => `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}`;
  const currentMonth = () => state.currentMonth || monthNow();
  const pattern = id => state.patterns.find(p=>p.id===id);
  const staff = id => state.staff.find(s=>s.id===id);
  const jobName = id => state.jobs.find(j=>j.id===id)?.name || "";
  const staffName = id => staff(id)?.name || "不明";
  const patternName = id => pattern(id)?.name || "";
  function skillCoversJob(source,skillId,targetJob){
    const skill=source.jobs.find(j=>j.id===skillId);
    if(!skill||!targetJob)return false;
    const targetCode=String(targetJob.code||"").toUpperCase();
    if(!targetCode)return false;
    const raw=String(skill.detail||"").toUpperCase();
    const codes=new Set();
    (raw.match(/[A-Z]/g)||[]).forEach(ch=>codes.add(ch));
    raw.split(/[,、\s/]+/).filter(Boolean).forEach(token=>codes.add(token));
    if(String(skill.content||"").trim() && raw.includes(String(skill.content).trim().toUpperCase()))codes.add(targetCode);
    if(String(skill.name||"").trim() && raw.includes(String(skill.name).trim().toUpperCase()) && String(skill.code||"").toUpperCase()===targetCode)codes.add(targetCode);
    return codes.has(targetCode) || (String(skill.code||"").toUpperCase()===targetCode && codes.size===0);
  }
  function staffCanDoJob(source,s,targetJob){
    if(!s||!targetJob)return false;
    return (s.skills||[]).some(skillId=>skillCoversJob(source,skillId,targetJob));
  }

  const DEFAULT_STATE = {
    staff: [],
    jobs: [],
    patterns: [],
    coverage: [],
    jobRules: [],
    rules:{
      respectDays:true,
      avoidConsecutive:true,
      respectAvailability:true,
      priority:["希望休を優先","勤務希望曜日・時間を優先","勤務日数を均等化","5日間以上の連勤を避ける"],
      items:[
        {id:"rule1",name:"希望休を優先",enabled:true},
        {id:"rule2",name:"勤務希望曜日・時間を優先",enabled:true},
        {id:"rule3",name:"勤務日数を均等化",enabled:true},
        {id:"rule4",name:"5日間以上の連勤を避ける",enabled:true}
      ]
    },
    holidays:{weekly:[],exceptions:{}},
    months:{},
    currentMonth:monthNow(),
    lastGeneratedAt:"",
    version:STATE_VERSION,
    savedSchedules:[]
  };

  function normalizeStaff(s){
    return {
      ...s,
      id:s.id||uid("staff"),
      name:typeof s.name==="string"?s.name:"",
      days:Number.isFinite(Number(s.days))?Number(s.days):0,
      start:s.start||"06:00",
      end:s.end||"18:00",
      skills:Array.isArray(s.skills)?s.skills:[],
      patterns:Array.isArray(s.patterns)?s.patterns.slice():[],
      weekdays:Array.isArray(s.weekdays)?s.weekdays.slice():[],
      offDates:Array.isArray(s.offDates)?s.offDates:[]
    };
  }
  function normalizeJob(j,index=0){
    const fallbackCode=String.fromCharCode(65+index);
    const code=String(j?.code||fallbackCode).trim().toUpperCase();
    return {
      ...j,
      id:j?.id||uid("job"),
      code:code||fallbackCode,
      name:typeof j?.name==="string"?j.name:"",
      content:typeof j?.content==="string"?j.content:(code||fallbackCode),
      detail:typeof j?.detail==="string"?j.detail:(code||fallbackCode)
    };
  }
  const statePatterns = () => ["p1","p2"];

  function normalizeState(parsed){
    const base=clone(DEFAULT_STATE);
    const out={...base,...parsed};
    out.staff=Array.isArray(parsed.staff)?parsed.staff.map(normalizeStaff):base.staff.map(normalizeStaff);
    out.jobs=Array.isArray(parsed.jobs)?parsed.jobs.map((j,i)=>normalizeJob(j,i)):base.jobs;
    out.patterns=Array.isArray(parsed.patterns)&&parsed.patterns.length?parsed.patterns:base.patterns;
    const patternIds=out.patterns.map(p=>p.id);
    out.staff=out.staff.map(s=>({...s,patterns:Array.isArray(s.patterns)?s.patterns.filter(id=>patternIds.includes(id)):[]}));
    out.coverage=Array.isArray(parsed.coverage)?parsed.coverage:[];
    out.patterns.forEach(p=>{
      let c=out.coverage.find(x=>x.pattern===p.id);
      if(!c){ c={id:uid("cov"),pattern:p.id,mins:[1,1,1,1,1,1,1]};out.coverage.push(c); }
      c.mins=Array.from({length:7},(_,i)=>Math.max(0,Number(c.mins?.[i])||0));
    });
    out.coverage=out.coverage.filter(c=>out.patterns.some(p=>p.id===c.pattern));
    out.jobRules=Array.isArray(parsed.jobRules)?parsed.jobRules:[];
    out.jobRules=out.jobRules.filter(r=>out.jobs.some(j=>j.id===r.job)&&out.patterns.some(p=>p.id===r.pattern)).map(r=>{
      const legacy=Number(r.min)||0;
      const mins=Array.isArray(r.mins)?r.mins.slice(0,7):Array(7).fill(legacy);
      while(mins.length<7)mins.push(legacy);
      return {...r,mins:mins.map(v=>Math.max(0,Number(v)||0)),min:Math.max(0,legacy)};
    });
    out.rules={...base.rules,...(parsed.rules||{})};
    const ruleNames=["希望休を優先","勤務希望曜日・時間を優先","勤務日数を均等化","5日間以上の連勤を避ける"];
    const normalizeRuleName = name => name === "連勤をできるだけ避ける" ? "5日間以上の連勤を避ける" : name;
    if(!Array.isArray(out.rules.items)||!out.rules.items.length){
      const priority=Array.isArray(out.rules.priority)?out.rules.priority:ruleNames;
      out.rules.items=priority.filter(x=>ruleNames.includes(x)).map((name,i)=>({id:uid("rule"),name,enabled:true}));
    } else {
      out.rules.items=out.rules.items.filter(x=>ruleNames.includes(x.name)).map(x=>({...x,id:x.id||uid("rule"),enabled:x.enabled!==false}));
    }
    out.rules.priority=out.rules.items.filter(x=>x.enabled).map(x=>x.name);
    out.holidays={...base.holidays,...(parsed.holidays||{}),exceptions:{...(parsed.holidays?.exceptions||{})}};
    out.months=parsed.months&&typeof parsed.months==="object"?parsed.months:{};
    out.savedSchedules=Array.isArray(parsed.savedSchedules)?parsed.savedSchedules:[];
    out.currentMonth=parsed.currentMonth||monthNow();
    out.version=STATE_VERSION;
    return out;
  }

  function createSampleState(month=monthNow()){
    const sample=clone(DEFAULT_STATE);
    sample.staff=[
      {id:"s1",name:"Aさん",days:5,start:"09:00",end:"15:00",skills:["job1"],patterns:["p1"],weekdays:[0,1,2,3,4],offDates:["5"]},
      {id:"s2",name:"Bさん",days:5,start:"09:00",end:"15:00",skills:["job2"],patterns:["p1"],weekdays:[2,3,4,5,6],offDates:["4"]},
      {id:"s3",name:"Cさん",days:4,start:"12:00",end:"18:00",skills:["job1"],patterns:["p2"],weekdays:[2,3,4,5],offDates:["10"]},
      {id:"s4",name:"Dさん",days:4,start:"12:00",end:"18:00",skills:["job2"],patterns:["p2"],weekdays:[3,4,5,6],offDates:["15"]},
      {id:"s5",name:"Eさん",days:3,start:"12:00",end:"18:00",skills:["job1"],patterns:["p2"],weekdays:[0,1,5],offDates:["22"]},
      {id:"s6",name:"Fさん",days:3,start:"09:00",end:"15:00",skills:["job2"],patterns:["p1"],weekdays:[1,4,6],offDates:["28"]}
    ];
    sample.jobs=[
      {id:"job1",code:"A",name:"キッチン",content:"A",detail:"A"},
      {id:"job2",code:"B",name:"ホール",content:"B",detail:"B"}
    ];
    sample.patterns=[
      {id:"p1",name:"朝",start:"09:00",end:"15:00"},
      {id:"p2",name:"遅",start:"12:00",end:"18:00"}
    ];
    sample.coverage=[
      {id:"c1",pattern:"p1",mins:[1,1,1,1,1,1,1]},
      {id:"c2",pattern:"p2",mins:[1,1,1,1,1,1,1]}
    ];
    sample.jobRules=[];
    sample.rules=clone(DEFAULT_STATE.rules);
    sample.holidays={weekly:[],exceptions:{}};
    sample.currentMonth=month;
    sample.months={};
    sample.savedSchedules=[];
    sample.lastGeneratedAt="";
    sample.version=STATE_VERSION;
    return sample;
  }

  function migrateRaw(){
    // V44はV43以前のデータを引き継がず、初回起動は指定サンプル6名から開始します。
    // V44で管理者が明示的に保存したデータだけを、次回以降の起動時に復元します。
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return createSampleState(monthNow());
    try{
      const parsed=JSON.parse(raw);
      return normalizeState(parsed);
    }catch(e){
      return clone(DEFAULT_STATE);
    }
  }
  let state=migrateRaw();
  let selectedSavedScheduleId="";

  function toast(msg){const e=$("#toast");if(!e)return;e.textContent=msg;e.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("show"),2800);}
  function syncCurrentForm(){
    // ボタンを押した瞬間に、画面上の最新入力値をstateへ同期します。
    // 自動作成・再チェックは、この同期後のstateだけを使います。
    $$("[data-staff]").forEach(e=>{const s=staff(e.dataset.staff);if(s&&e.matches("input"))s.name=e.value.trim()||"新しいスタッフ";});
    $$("[data-days]").forEach(e=>{const s=staff(e.dataset.days);if(s)s.days=Math.max(0,Math.min(7,Number(e.value)||0));});
    $$("[data-weekday]").forEach(e=>{const s=staff(e.dataset.weekday);if(s){const i=Number(e.dataset.i);s.weekdays=e.checked?[...new Set([...(s.weekdays||[]),i])]:((s.weekdays||[]).filter(x=>x!==i));}});
    $$("[data-spattern]").forEach(e=>{const s=staff(e.dataset.spattern);if(s)s.patterns=e.checked?[...new Set([...(s.patterns||[]),e.value])]:((s.patterns||[]).filter(x=>x!==e.value));});
    $$("[data-skill]").forEach(e=>{const s=staff(e.dataset.skill);if(s)s.skills=e.checked?[...new Set([...(s.skills||[]),e.value])]:((s.skills||[]).filter(x=>x!==e.value));});
    $$("[data-offdates]").forEach(e=>{const s=staff(e.dataset.offdates);if(s)s.offDates=e.value.split(",").map(x=>x.trim()).filter(Boolean);});
    $$("[data-job-code]").forEach(e=>{const j=state.jobs.find(x=>x.id===e.dataset.jobCode);if(j&&e.value.trim())j.code=e.value.trim().toUpperCase();});
    $$("[data-job-name]").forEach(e=>{const j=state.jobs.find(x=>x.id===e.dataset.jobName);if(j)j.name=e.value.trim();});
    $$("[data-job-content]").forEach(e=>{const j=state.jobs.find(x=>x.id===e.dataset.jobContent);if(j)j.content=e.value.trim();});
    $$("[data-job-detail]").forEach(e=>{const j=state.jobs.find(x=>x.id===e.dataset.jobDetail);if(j)j.detail=e.value.trim();});
    $$("[data-pattern-name]").forEach(e=>{const p=pattern(e.dataset.patternName);if(p)p.name=e.value.trim()||"勤務";});
    $$("[data-pattern-time]").forEach(e=>{const p=pattern(e.dataset.patternTime);if(p)p[e.dataset.side]=e.value;});
    $$("[data-cover]").forEach(e=>{const c=state.coverage.find(x=>x.pattern===e.dataset.cover);if(c)c.mins[Number(e.dataset.i)]=Math.max(0,Number(e.value)||0);});
    $$("[data-job-matrix]").forEach(e=>{const r=state.jobRules.find(x=>x.id===e.dataset.jobMatrix);if(r){const i=Number(e.dataset.i);r.mins=Array.isArray(r.mins)?r.mins:Array(7).fill(Number(r.min)||0);r.mins[i]=Math.max(0,Number(e.value)||0);r.min=r.mins.reduce((a,v)=>a+Number(v||0),0);}});
  }

  // V42: 自動保存は行わない。保存は管理者が「設定を保存」または「このシフトを保存」を押した時だけ。
  function persistState(){
    // V42: 管理者の明示的な保存操作だけがlocalStorageへ書き込みます。
    // 自動作成中の未保存シフト(months)は保存しません。
    state.version=STATE_VERSION;
    const stored=clone(state);
    stored.months={};
    localStorage.setItem(STORAGE_KEY,JSON.stringify(stored));
  }
  function loadSavedPlanningState(){
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      if(!raw)return null;
      return normalizeState(JSON.parse(raw));
    }catch(e){return null;}
  }
  function getLatestSavedPlanningSource(){
    const saved=loadSavedPlanningState();
    if(!saved)return null;
    return normalizeState(clone(saved));
  }

  function setSaveButtonState(saved){
    $$('[data-save]').forEach(b=>{
      b.textContent=saved?"保存済み":"設定を保存";
      b.classList.toggle("saved",saved);
      b.classList.remove("saving");
    });
  }
  function flashSaveState(){
    $$('[data-save]').forEach(b=>b.classList.add("saving"));
    requestAnimationFrame(()=>requestAnimationFrame(()=>setSaveButtonState(true)));
  }
  function setShiftSaveButtonState(saved){
    const header=$("#saveShiftHeader"), current=$("#saveNamedSchedule");
    [header,current].forEach(b=>{if(b){b.classList.toggle("saved",saved);b.textContent=saved?"保存済み":"このシフトを保存";}});
  }
  function refreshShiftSaveState(){
    const month=currentMonth(),md=getMonthData(month);
    const saved=!!state.savedSchedules?.some(r=>r.month===month) && md.status==="created" && !md.stale;
    setShiftSaveButtonState(saved);
  }
  function saveState(show=true){
    persistState();
    setSaveButtonState(true);
    if(show)toast("設定を保存しました");
  }
  function saveSettings(show=true){
    syncCurrentForm();
    const p=preparationStatus();
    // 入力内容そのものは、条件の未完成・不一致があっても保存します。
    // 「保存できない」状態にせず、必要な修正だけをメッセージで知らせます。
    persistState();
    flashSaveState();
    renderSettings();renderBasic();renderShift();
    if(show){
      toast(p.jobRulesOk ? "設定を保存しました" : "設定を保存しました。必要人数と業務別必要人数の合計を確認してください");
    }
    return true;
  }
  function saveCurrentWork(show=true){
    syncCurrentForm();
    const month=currentMonth(),md=getMonthData(month);
    if(md.status!=="created"){
      saveState(false);
      if(show)toast("保存できる作成済みシフトがありません");
      return;
    }
    md.stale=false;
    md.updatedAt=new Date().toISOString();
    const existing=state.savedSchedules.find(r=>r.month===month);
    const record={
      id:existing?.id||uid("saved"),
      name:existing?.name||`${Number(month.slice(5))}月シフト`,
      month,
      updatedAt:md.updatedAt,
      snapshot:snapshotForSave(month)
    };
    if(existing){
      const i=state.savedSchedules.findIndex(r=>r.id===existing.id);
      state.savedSchedules[i]=record;
    }else{
      state.savedSchedules.unshift(record);
    }
    selectedSavedScheduleId=record.id;
    persistState();
    setShiftSaveButtonState(true);
    renderSavedSchedules();
    if(show)toast(`${Number(month.slice(5))}月シフトを保存しました`);
  }
  function markChanged(){
    $$('[data-save]').forEach(b=>{
      b.textContent="設定を保存";
      b.classList.remove("saved","saving");
    });
  }
  function getMonthData(month){if(!state.months[month])state.months[month]={status:"uncreated",confirmed:false,schedule:[],warnings:[],generatedAt:"",stale:false};const md=state.months[month];md.schedule=Array.isArray(md.schedule)?md.schedule:[];md.warnings=Array.isArray(md.warnings)?md.warnings:[];return md;}
  function invalidateMonths(){Object.values(state.months).forEach(md=>{if(md.schedule?.length||md.status==="created"||md.confirmed){md.status="stale";md.stale=true;md.confirmed=false;}});markChanged();}

  function jobRuleMismatches(){
    const mismatches=[];
    for(const p of state.patterns){
      const coverage=state.coverage.find(c=>c.pattern===p.id);
      for(let wd=0;wd<7;wd++){
        const need=Math.max(0,Number(coverage?.mins?.[wd])||0);
        const active=state.jobRules.filter(r=>r.pattern===p.id&&jobNeedFrom(r,wd)>0);
        if(!active.length)continue;
        const sum=active.reduce((total,r)=>total+jobNeedFrom(r,wd),0);
        if(sum!==need)mismatches.push({pattern:p.id,weekday:wd,need,sum});
      }
    }
    return mismatches;
  }
  function preparationStatus(){
    const staffOk=state.staff.length>0&&state.staff.every(s=>s.name&&s.weekdays?.length&&s.patterns?.length);
    const patternsOk=state.patterns.length>0&&state.patterns.every(p=>toMin(p.start)>=360&&toMin(p.end)<=1440&&toMin(p.start)<toMin(p.end));
    const codes=state.jobs.map(j=>String(j.code||"").trim().toUpperCase()).filter(Boolean);
    const uniqueCodes=new Set(codes).size===codes.length;
    const jobsOk=state.jobs.length>0&&state.jobs.every(j=>j.code&&j.name&&j.content&&j.detail)&&uniqueCodes;
    const coverageOk=state.patterns.length>0&&state.patterns.every(p=>state.coverage.some(c=>c.pattern===p.id));
    const jobRulesOk=jobRuleMismatches().length===0;
    return {staffOk,patternsOk,jobsOk,coverageOk,jobRulesOk,holidayOk:true,all:staffOk&&patternsOk&&jobsOk&&coverageOk&&jobRulesOk};
  }

  function openShiftAndCreate(){
    showView("shift");
    autoCreate();
  }
  function renderNavigation(){
    $$('.nav-item').forEach(b=>b.onclick=()=>{
      const target=b.dataset.view;
      if(target==="shift")openShiftAndCreate();
      else showView(target);
      $(".main-nav .nav-inner")?.classList.remove("mobile-open");
      $("#mainNavToggle")?.setAttribute("aria-expanded","false");
    });
    $$('[data-go]').forEach(b=>b.onclick=()=>{
      const target=b.dataset.go;
      if(target==="top")showTop();
      else if(target==="home")showWelcome();
      else if(target==="shift")openShiftAndCreate();
      else showView(target);
    });
    $("#brandHome")?.addEventListener("click",e=>{e.preventDefault();showWelcome();});
    $$('[data-save]').forEach(b=>b.onclick=()=>saveSettings(true));
    const hamburger=$('#headerHamburger');
    const headerNav=$('#headerNav');
    const mainNavToggle=$('#mainNavToggle');
    const mainNav=$('.main-nav .nav-inner');
    mainNavToggle?.addEventListener('click',()=>{
      const open=!mainNav?.classList.contains('mobile-open');
      mainNav?.classList.toggle('mobile-open',open);
      mainNavToggle.setAttribute('aria-expanded',String(open));
    });
    hamburger?.addEventListener('click',()=>{
      const open=!headerNav?.classList.contains('open');
      headerNav?.classList.toggle('open',open);
      hamburger.setAttribute('aria-expanded',String(open));
    });
    $$('[data-header-view]').forEach(b=>b.onclick=()=>{
      const target=b.dataset.headerView;
      const pop=$('#headerPopover');
      if(pop){
        pop.textContent=b.dataset.headerMessage||'';
        pop.classList.add('show');
        clearTimeout(window.__autoHeaderPopoverTimer);
        window.__autoHeaderPopoverTimer=setTimeout(()=>pop.classList.remove('show'),2600);
      }
      headerNav?.classList.remove('open');
      hamburger?.setAttribute('aria-expanded','false');
      if(target==='advanced'){
        showView('settings');
        setTimeout(()=>$('#advancedJobSection')?.scrollIntoView({behavior:'smooth',block:'start'}),100);
      }else if(target==='autoshift'){
        // 右上のAUTOSHIFTは、どの画面からでもウェルカム（トップ）画面へ戻る。
        showWelcome();
      }else{
        showView(target);
      }
    });
  }
  function showWelcome(){
    localStorage.setItem(CURRENT_VIEW_KEY,"home");
    $$('.view-panel').forEach(v=>v.classList.toggle('active',v.id==='view-home'));
    $$('.nav-item').forEach(v=>v.classList.remove('active'));
    document.body.classList.remove('top-mode');
    document.body.classList.add('welcome-mode');
    window.scrollTo({top:0,behavior:'smooth'});
  }

  function showTop(){
    $$('.view-panel').forEach(v=>v.classList.remove('active'));
    $$('.nav-item').forEach(v=>v.classList.remove('active'));
    document.body.classList.remove('welcome-mode');
    document.body.classList.add('top-mode');
    setTimeout(()=>document.querySelector('.hero-card')?.scrollIntoView({behavior:'smooth',block:'start'}),20);
  }
  function showView(view){
    // V40: 画面移動だけでは保存しない。入力値の保存は管理者の保存操作でのみ行う。
    localStorage.setItem(CURRENT_VIEW_KEY,view);
    $$('.view-panel').forEach(v=>v.classList.toggle('active',v.id===`view-${view}`));
    $$('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===view));
    document.body.classList.remove('welcome-mode','top-mode');
    const t=$(`#view-${view}`);
    if(t)setTimeout(()=>window.scrollTo({top:Math.max(0,t.offsetTop-82),behavior:'smooth'}),20);
  }

  function timeSelect(value,cls,data=""){
    let h="<select class='"+cls+"' "+data+">";
    for(let m=360;m<=1440;m+=15){const v=`${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;h+=`<option value="${v}" ${v===value?"selected":""}>${v}</option>`;}
    return h+"</select>";
  }

  function renderBasic(){
    const box=$("#basicStaffList");if(!box)return;
    box.innerHTML=`<div class="staff-table-wrap"><table class="staff-info-table"><thead><tr><th>スタッフ</th><th>週勤務</th><th>勤務曜日</th><th>勤務パターン</th><th>担当業務</th><th>希望休</th><th>操作</th></tr></thead><tbody>${state.staff.map(s=>{
      const dayChecks=DAYS.map((d,i)=>`<label class="check-item"><input type="checkbox" data-weekday="${s.id}" data-i="${i}" ${s.weekdays.includes(i)?"checked":""}><span>${d}</span></label>`).join("");
      const pats=state.patterns.map(p=>`<label class="check-item pattern-choice"><input type="checkbox" data-spattern="${s.id}" value="${p.id}" ${s.patterns.includes(p.id)?"checked":""}><span>${esc(p.name)}　${esc(p.start)}～${esc(p.end)}</span></label>`).join("");
      const skills=state.jobs.map(j=>`<label class="check-item"><input type="checkbox" data-skill="${s.id}" value="${j.id}" ${s.skills.includes(j.id)?"checked":""}><span>${esc(j.name)}</span></label>`).join("");
      return `<tr><td><input class="staff-name-input" data-staff="${s.id}" placeholder="新しいスタッフ" value="${esc(s.name)}"></td><td><div class="days-input"><input type="number" min="0" max="7" data-days="${s.id}" value="${Number(s.days)>0?Number(s.days):""}"><span>日</span></div></td><td><div class="day-checks">${dayChecks}</div></td><td><div class="pattern-checks">${pats}</div><small>勤務時間は「設定」の勤務パターンに連動します。管理者は✓のみ変更します。</small></td><td><div class="skill-checks">${skills}</div><small>未設定なら業務条件なし</small></td><td><input class="offdates-input" type="text" placeholder="例：1,5,7" data-offdates="${s.id}" value="${esc((s.offDates||[]).join(","))}"><small>日付番号で入力</small></td><td><button type="button" class="delete-button delete-staff-button" data-delete-staff="${s.id}">削除</button></td></tr>`;
    }).join("")}</tbody></table></div>`;
    box.querySelectorAll('[data-staff]').forEach(e=>e.onchange=()=>{const s=staff(e.dataset.staff);if(s){s.name=e.value.trim()||"新しいスタッフ";invalidateMonths();renderShift();markChanged();}});
    box.querySelectorAll('[data-days]').forEach(e=>e.onchange=()=>{const s=staff(e.dataset.days);if(s){s.days=Math.max(0,Math.min(7,Number(e.value)||0));invalidateMonths();renderShift();markChanged();}});
    box.querySelectorAll('[data-weekday]').forEach(e=>e.onchange=()=>{const s=staff(e.dataset.weekday);if(s){const i=Number(e.dataset.i);s.weekdays=e.checked?[...new Set([...s.weekdays,i])]:s.weekdays.filter(x=>x!==i);invalidateMonths();renderShift();markChanged();}});
    box.querySelectorAll('[data-spattern]').forEach(e=>e.onchange=()=>{const s=staff(e.dataset.spattern);if(s){s.patterns=e.checked?[...new Set([...s.patterns,e.value])]:s.patterns.filter(x=>x!==e.value);invalidateMonths();renderShift();markChanged();}});
    box.querySelectorAll('[data-skill]').forEach(e=>e.onchange=()=>{const s=staff(e.dataset.skill);if(s){s.skills=e.checked?[...new Set([...s.skills,e.value])]:s.skills.filter(x=>x!==e.value);invalidateMonths();renderShift();markChanged();}});
    box.querySelectorAll('[data-offdates]').forEach(e=>e.onchange=()=>{const s=staff(e.dataset.offdates);if(s){s.offDates=e.value.split(",").map(x=>x.trim()).filter(Boolean);invalidateMonths();renderShift();markChanged();}});
    box.querySelectorAll('[data-delete-staff]').forEach(b=>b.onclick=()=>{if(state.staff.length<=1){toast("スタッフは1名以上必要です");return;}if(!confirm("このスタッフを削除しますか？"))return;state.staff=state.staff.filter(s=>s.id!==b.dataset.deleteStaff);invalidateMonths();renderBasic();renderShift();markChanged();toast("スタッフを削除しました");});
    $("#basicStaffCount").textContent=`${state.staff.length}名`;$("#basicPatternCount").textContent=`${state.patterns.length}件`;
    const p=preparationStatus();$("#basicCoverageStatus").textContent=!p.coverageOk?"未設定":p.jobRulesOk?"設定済み":"要確認";$("#basicHolidayStatus").textContent="設定済み";$("#basicStatus").textContent=p.all?"準備完了":"設定を確認";
    renderPreparation();
  }
  function renderPreparation(){const box=$("#preparationStatus");if(!box)return;const p=preparationStatus();box.innerHTML=`<div class="prep-final ${p.all?"ok":"bad"}"><span class="prep-dot">●</span><strong>${p.all?"準備完了":"準備未完了"}</strong><small>スタッフ ${state.staff.length}名 / 勤務 ${state.patterns.length}種 / 業務 ${state.jobs.length}種${p.jobRulesOk?"":" / 必要人数不一致"}</small></div>`;}

  function renderSettings(){
    const jobBox=$("#jobList");
    if(jobBox){
      jobBox.innerHTML=`<div class="job-skill-head"><strong>業務コード</strong><strong>業務スキル名</strong><strong>業務内容</strong><strong>詳細</strong><strong></strong></div>`+
        state.jobs.map(j=>`<div class="job-skill-row">
          <input class="job-code-input" data-job-code="${j.id}" value="${esc(j.code)}" maxlength="10" aria-label="業務コード">
          <input data-job-name="${j.id}" value="${esc(j.name)}" placeholder="例：キッチン" aria-label="業務スキル名">
          <input data-job-content="${j.id}" value="${esc(j.content)}" placeholder="例：A" aria-label="業務内容">
          <input data-job-detail="${j.id}" value="${esc(j.detail)}" placeholder="例：A,B,C" aria-label="詳細">
          <button type="button" class="delete-button" data-delete-job="${j.id}">削除</button>
        </div>`).join("");
      jobBox.querySelectorAll('[data-job-code]').forEach(e=>e.onchange=()=>{
        const j=state.jobs.find(x=>x.id===e.dataset.jobCode);if(!j)return;
        const next=e.value.trim().toUpperCase();
        if(!next){e.value=j.code;toast("業務コードは必須です");return;}
        const duplicate=state.jobs.some(x=>x.id!==j.id&&String(x.code||"").toUpperCase()===next);
        if(duplicate){e.value=j.code;toast("同じ業務コードは使用できません");return;}
        j.code=next;invalidateMonths();renderBasic();renderJobRules();renderShift();markChanged();
      });
      jobBox.querySelectorAll('[data-job-name]').forEach(e=>e.onchange=()=>{
        const j=state.jobs.find(x=>x.id===e.dataset.jobName);if(j){j.name=e.value.trim();invalidateMonths();renderBasic();renderJobRules();renderShift();markChanged();}
      });
      jobBox.querySelectorAll('[data-job-content]').forEach(e=>e.onchange=()=>{
        const j=state.jobs.find(x=>x.id===e.dataset.jobContent);if(j){j.content=e.value.trim();invalidateMonths();renderBasic();renderJobRules();renderShift();markChanged();}
      });
      jobBox.querySelectorAll('[data-job-detail]').forEach(e=>e.onchange=()=>{
        const j=state.jobs.find(x=>x.id===e.dataset.jobDetail);if(j){j.detail=e.value.trim();invalidateMonths();renderBasic();renderJobRules();renderShift();markChanged();}
      });
    }
    jobBox?.querySelectorAll('[data-delete-job]').forEach(b=>b.onclick=()=>{if(state.jobs.length<=1){toast("業務は1つ以上必要です");return;}const id=b.dataset.deleteJob;state.jobs=state.jobs.filter(j=>j.id!==id);state.staff.forEach(s=>s.skills=(s.skills||[]).filter(x=>x!==id));state.jobRules=state.jobRules.filter(r=>r.job!==id);invalidateMonths();renderSettings();renderBasic();renderShift();toast("業務を削除しました");});

    const pBox=$("#patternList");
    if(pBox)pBox.innerHTML=state.patterns.map(p=>`<div class="settings-row pattern-row"><input data-pattern-name="${p.id}" value="${esc(p.name)}">${timeSelect(p.start,"pattern-time",`data-pattern-time="${p.id}" data-side="start"`)}<span>～</span>${timeSelect(p.end,"pattern-time",`data-pattern-time="${p.id}" data-side="end"`)}<button type="button" class="delete-button" data-delete-pattern="${p.id}">削除</button></div>`).join("");
    pBox?.querySelectorAll('[data-pattern-name]').forEach(e=>e.onchange=()=>{const p=pattern(e.dataset.patternName);if(p){p.name=e.value.trim()||"勤務";invalidateMonths();renderBasic();renderShift();renderSettings();markChanged();}});
    pBox?.querySelectorAll('[data-pattern-time]').forEach(e=>e.onchange=()=>{const p=pattern(e.dataset.patternTime);if(p){p[e.dataset.side]=e.value;invalidateMonths();renderBasic();renderShift();markChanged();}});
    pBox?.querySelectorAll('[data-delete-pattern]').forEach(b=>b.onclick=()=>{if(state.patterns.length<=1){toast("勤務パターンは1つ以上必要です");return;}const id=b.dataset.deletePattern;state.patterns=state.patterns.filter(p=>p.id!==id);state.coverage=state.coverage.filter(c=>c.pattern!==id);state.jobRules=state.jobRules.filter(r=>r.pattern!==id);state.staff.forEach(s=>s.patterns=(s.patterns||[]).filter(x=>x!==id));invalidateMonths();renderSettings();renderBasic();renderShift();toast("勤務パターンを削除しました");});

    renderCoverage();renderJobRules();renderRulePriority();
  }

  function renderCoverage(){
    const table=$("#coverageTable");if(!table)return;
    const mismatchSet=new Set(jobRuleMismatches().map(x=>`${x.pattern}|${x.weekday}`));
    table.innerHTML=`<thead><tr><th>勤務パターン</th>${DAYS.map(d=>`<th>${d}</th>`).join("")}</tr></thead><tbody>${state.patterns.map(p=>{
      const c=state.coverage.find(x=>x.pattern===p.id);
      return `<tr><th>${esc(p.name)}</th>${DAYS.map((d,i)=>`<td class="${mismatchSet.has(`${p.id}|${i}`)?"coverage-mismatch":""}"><input type="number" min="0" max="30" data-cover="${p.id}" data-i="${i}" value="${Number(c?.mins?.[i])||0}"></td>`).join("")}</tr>`;
    }).join("")}</tbody>`;
    table.querySelectorAll('[data-cover]').forEach(e=>e.onchange=()=>{
      const c=state.coverage.find(x=>x.pattern===e.dataset.cover);
      if(c){c.mins[Number(e.dataset.i)]=Math.max(0,Number(e.value)||0);invalidateMonths();renderSettings();renderShift();markChanged();}
    });
  }

  function renderJobRules(){
    const box=$("#jobRuleList");if(!box)return;
    const rules=state.jobRules
      .filter(r=>state.jobs.some(j=>j.id===r.job)&&state.patterns.some(p=>p.id===r.pattern))
      .slice()
      .sort((a,b)=>(state.patterns.findIndex(p=>p.id===a.pattern)-state.patterns.findIndex(p=>p.id===b.pattern))
        ||(state.jobs.findIndex(j=>j.id===a.job)-state.jobs.findIndex(j=>j.id===b.job)));
    const head=`<div class="job-rule-matrix-head"><strong>業務スキル</strong><strong>勤務</strong>${DAYS.map(d=>`<strong>${d}</strong>`).join("")}<strong>合計</strong><strong></strong></div>`;
    const rows=rules.map(r=>{
      const j=state.jobs.find(x=>x.id===r.job),p=pattern(r.pattern);
      const mins=Array.isArray(r.mins)?r.mins:Array(7).fill(Number(r.min)||0);
      const total=mins.reduce((a,v)=>a+Number(v||0),0);
      const jobLabel=j?`${j.code} ${j.name||"未入力"}`:"";
      const patternLabel=p?`${p.name}　${p.start}～${p.end}`:"";
      return `<div class="job-rule-row job-rule-row-matrix"><strong class="job-rule-job">${esc(jobLabel)}</strong><span class="job-rule-pattern">${esc(patternLabel)}</span>${DAYS.map((d,i)=>`<input type="number" min="0" max="30" data-job-matrix="${r.id}" data-i="${i}" value="${Number(mins[i])||0}">`).join("")}<strong>${total}</strong><button type="button" class="delete-button small-delete" data-delete-job-rule="${r.id}">削除</button></div>`;
    });
    const mismatches=jobRuleMismatches();
    const alert=mismatches.length?`<div class="job-rule-validation-alert">⚠ 必要人数と業務別必要人数の合計が一致していません。赤い項目を確認してください。</div>`:"";
    box.innerHTML=head+(rows.join("")||`<p class="setting-note">現在、業務別の必要条件はありません。必要になったら「条件を追加」してください。</p>`)+alert+`<p class="setting-note">※ 人数0の曜日は条件として扱いません。業務別必要人数を設定した曜日は、その合計を上の「必要人数」と一致させてください。</p>`;
    box.querySelectorAll('[data-job-matrix]').forEach(e=>e.onchange=()=>{
      const r=state.jobRules.find(x=>x.id===e.dataset.jobMatrix);
      if(r){
        const i=Number(e.dataset.i);
        r.mins=Array.isArray(r.mins)?r.mins:Array(7).fill(Number(r.min)||0);
        r.mins[i]=Math.max(0,Number(e.value)||0);
        r.min=r.mins.reduce((a,v)=>a+Number(v||0),0);
        invalidateMonths();renderSettings();renderShift();markChanged();
      }
    });
    box.querySelectorAll('[data-delete-job-rule]').forEach(b=>b.onclick=()=>{
      state.jobRules=state.jobRules.filter(r=>r.id!==b.dataset.deleteJobRule);
      invalidateMonths();renderSettings();renderShift();markChanged();toast("業務別必要条件を削除しました");
    });
  }

  function addJobRule(){
    const available=[];
    state.jobs.forEach(j=>state.patterns.forEach(p=>{if(!state.jobRules.some(r=>r.job===j.id&&r.pattern===p.id))available.push([j,p]);}));
    if(!available.length){toast("追加できる業務別条件はありません");return;}
    const [j,p]=available[0];state.jobRules.push({id:uid("jr"),job:j.id,pattern:p.id,min:0,mins:Array(7).fill(0)});
    invalidateMonths();renderSettings();renderShift();toast(`${j.name}・${p.name}の条件を追加しました`);
  }
  function renderRulePriority(){
    const box=$("#rulePriorityList");if(!box)return;
    const options=["希望休を優先","勤務希望曜日・時間を優先","勤務日数を均等化","5日間以上の連勤を避ける"];
    // 現在の並び順をそのまま維持し、欠けているルールだけ末尾に追加します。
    const existing=Array.isArray(state.rules.items)?state.rules.items.filter(x=>options.includes(x.name)):[];
    const missing=options.filter(name=>!existing.some(x=>x.name===name)).map(name=>({id:uid("rule"),name,enabled:true}));
    state.rules.items=[...existing,...missing].map(x=>({...x,id:x.id||uid("rule")}));
    box.innerHTML=`<div class="rule-editor-head"><strong>自動作成ルール</strong><span>使用するルールをON/OFFし、▲▼で優先順位を変更します。</span></div>${state.rules.items.map((r,i)=>`<div class="rule-editor-row"><span class="rule-number">${i+1}</span><strong class="rule-name">${esc(r.name)}</strong><label class="rule-enabled"><input type="checkbox" data-rule-enabled="${r.id}" ${r.enabled!==false?"checked":""}> 使用</label><div class="rule-move"><button type="button" class="rule-move-button" data-rule-up="${r.id}" ${i===0?"disabled":""}>▲</button><button type="button" class="rule-move-button" data-rule-down="${r.id}" ${i===state.rules.items.length-1?"disabled":""}>▼</button></div></div>`).join("")}`;
    state.rules.priority=state.rules.items.filter(x=>x.enabled!==false).map(x=>x.name);
    box.querySelectorAll('[data-rule-enabled]').forEach(e=>e.onchange=()=>{const r=state.rules.items.find(x=>x.id===e.dataset.ruleEnabled);if(r){r.enabled=e.checked;state.rules.priority=state.rules.items.filter(x=>x.enabled!==false).map(x=>x.name);invalidateMonths();renderShift();markChanged();}});
    const move=(id,delta)=>{const i=state.rules.items.findIndex(x=>x.id===id),j=i+delta;if(i<0||j<0||j>=state.rules.items.length)return;[state.rules.items[i],state.rules.items[j]]=[state.rules.items[j],state.rules.items[i]];state.rules.priority=state.rules.items.filter(x=>x.enabled!==false).map(x=>x.name);invalidateMonths();renderRulePriority();renderShift();markChanged();};
    box.querySelectorAll('[data-rule-up]').forEach(b=>b.onclick=()=>move(b.dataset.ruleUp,-1));
    box.querySelectorAll('[data-rule-down]').forEach(b=>b.onclick=()=>move(b.dataset.ruleDown,1));
  }
  function renderOther(){
    const box=$("#weeklyHolidays");if(box)box.innerHTML=DAYS.map((d,i)=>`<label><input type="checkbox" data-weekly-holiday="${i}" ${state.holidays.weekly.includes(i)?"checked":""}>${d}</label>`).join("");
    box?.querySelectorAll('[data-weekly-holiday]').forEach(e=>e.onchange=()=>{const i=Number(e.dataset.weeklyHoliday);state.holidays.weekly=e.checked?[...new Set([...state.holidays.weekly,i])]:state.holidays.weekly.filter(x=>x!==i);invalidateMonths();renderShift();markChanged();});
    const hm=$("#holidayMonth");if(hm)hm.value=currentMonth();renderHolidayCalendar();renderExceptions();
  }
  function isClosed(month,day){const k=dateKey(month,day),ex=state.holidays.exceptions[k];if(ex)return ex.type==="closed";return state.holidays.weekly.includes(weekdayIndex(month,day));}
  function renderHolidayCalendar(){
    const box=$("#holidayCalendar"),month=$("#holidayMonth")?.value||currentMonth();if(!box)return;
    const [y,m]=month.split("-").map(Number),first=new Date(y,m-1,1).getDay(),offset=(first+6)%7,total=daysInMonth(month);
    let h=`<div class="calendar-week">${DAYS.map(d=>`<span>${d}</span>`).join("")}</div><div class="calendar-grid">`;
    for(let i=0;i<offset;i++)h+=`<div class="calendar-empty"></div>`;
    for(let d=1;d<=total;d++){const k=dateKey(month,d),closed=isClosed(month,d),ex=state.holidays.exceptions[k];h+=`<button type="button" class="calendar-day ${closed?"closed":"open"} ${ex?"exception":""}" data-hday="${k}"><strong>${d}</strong><small>${closed?"休日":"営業"}</small></button>`;}
    h+=`</div>`;box.innerHTML=h;
    box.querySelectorAll('[data-hday]').forEach(b=>b.onclick=()=>{
      const k=b.dataset.hday,day=Number(k.slice(-2)),closed=isClosed(month,day);
      if(closed){
        // 個別設定した休日を解除。週定休の場合だけ営業日の上書きを残します。
        if(state.holidays.weekly.includes(weekdayIndex(month,day))) state.holidays.exceptions[k]={type:"open"};
        else delete state.holidays.exceptions[k];
      }else{
        state.holidays.exceptions[k]={type:"closed"};
      }
      renderHolidayCalendar();renderExceptions();invalidateMonths();renderShift();markChanged();
    });
  }
  function renderExceptions(){const box=$("#holidayExceptions"),month=$("#holidayMonth")?.value||currentMonth();if(!box)return;const a=Object.entries(state.holidays.exceptions).filter(([k])=>k.startsWith(month)).sort(([a],[b])=>a.localeCompare(b));box.innerHTML=a.length?a.map(([k,v])=>`<div class="holiday-exception"><span>${Number(k.slice(-2))}日（${jpDay(month,Number(k.slice(-2)))}）</span><strong>${v.type==="closed"?"休日":"営業"}</strong></div>`).join(""):"<small>この月の個別休日はありません。</small>";}
  function hasOffDate(s,month,day){const d=String(day),full=dateKey(month,day),md=`${month.slice(5)}/${String(day).padStart(2,"0")}`;return (s.offDates||[]).some(x=>String(x).trim()===d||String(x).trim()===full||String(x).trim()===md);}
  function preferenceMatches(s,month,day,p){
    return !!s && s.weekdays?.includes(weekdayIndex(month,day)) && canWork(s,p) && !hasOffDate(s,month,day) && (!s.patterns?.length || s.patterns.includes(p.id));
  }
  function requirementFor(patternId,weekday){
    const c=state.coverage.find(x=>x.pattern===patternId);
    return Math.max(0,Number(c?.mins?.[weekday])||0);
  }
  function activeJobRules(patternId){
    return state.jobRules.filter(r=>r.pattern===patternId&&Number(r.min)>0);
  }
  function hasHardJobRequirement(patternId,jobId){
    return !!jobId && activeJobRules(patternId).some(r=>r.job===jobId&&Number(r.min)>0);
  }

  /*
   * 自動作成用の「読み込み元」です。
   * 画面に残っている以前の生成結果ではなく、毎回 state 全体を読み直して
   * 基本情報・設定・休日を一つのスナップショットとして扱います。
   */
  function readPlanningSource(){
    // ボタン操作のたびに、現在表示されている基本情報・設定を先に同期します。
    // ここで作った1つのスナップショットを、その後の「枠作成→配置→検査」の全工程で共有します。
    syncCurrentForm();
    return normalizeState(clone(state));
  }
  function isClosedFrom(source,month,day){
    const k=dateKey(month,day),ex=source.holidays?.exceptions?.[k];
    if(ex)return ex.type==="closed";
    return (source.holidays?.weekly||[]).includes(weekdayIndex(month,day));
  }
  function requirementFrom(source,patternId,weekday){
    const c=source.coverage.find(x=>x.pattern===patternId);
    return Math.max(0,Number(c?.mins?.[weekday])||0);
  }
  function patternFrom(source,id){return source.patterns.find(p=>p.id===id);}
  function staffFrom(source,id){return source.staff.find(s=>s.id===id);}
  function hasOffDateFrom(s,month,day){
    const d=String(day),full=dateKey(month,day),md=`${month.slice(5)}/${String(day).padStart(2,"0")}`;
    return (s.offDates||[]).some(x=>{const v=String(x).trim();return v===d||v===full||v===md;});
  }
  function overlapPatterns(a,b){return !!a&&!!b&&toMin(a.start)<toMin(b.end)&&toMin(b.start)<toMin(a.end);}
  function weeklyKeyFromDate(date){
    const [y,m,d]=date.split("-").map(Number),dt=new Date(y,m-1,d),js=dt.getDay();
    dt.setDate(dt.getDate()-((js+6)%7));
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
  }
  function countWeekAssignments(schedule,staffId,date){
    const wk=weeklyKeyFromDate(date);
    return schedule.filter(r=>r.staff===staffId&&weeklyKeyFromDate(r.date)===wk).length;
  }
  function consecutiveLength(schedule,staffId,date){
    const [y,m,d]=date.split("-").map(Number),dt=new Date(y,m-1,d);
    let count=1;
    for(let i=1;i<31;i++){
      dt.setDate(dt.getDate()-1);
      const k=dateKey(`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`,dt.getDate());
      if(schedule.some(r=>r.staff===staffId&&r.date===k)){count++;continue;}
      break;
    }
    return count;
  }
  function jobNeedFrom(rule,weekday){
    if(Array.isArray(rule.mins))return Math.max(0,Number(rule.mins[weekday])||0);
    return Math.max(0,Number(rule.min)||0);
  }
  function activeJobRulesFrom(source,patternId,weekday=null){
    return source.jobRules.filter(r=>r.pattern===patternId&&((weekday===null?Number(r.min):jobNeedFrom(r,weekday))>0));
  }
  function eligibleFrom(source,s,month,day,p,schedule,jobId=null){
    if(!s||!p||isClosedFrom(source,month,day))return false;
    const wd=weekdayIndex(month,day);
    // ここは「希望」ではなく、配置可能かどうかを決める基本条件です。
    if(!s.weekdays?.includes(wd))return false;
    // 勤務時間は設定の勤務パターンに紐づいているため、基本情報では時間を別管理しません。
    // スタッフが✓した勤務パターンだけを配置対象にします。
    if(!s.patterns?.includes(p.id))return false;
    // 希望休は自動作成でも配置不可。希望休の日は候補者から外します。
    // 「希望休を優先」は、希望休を無視して無理に配置するという意味ではありません。
    if(hasOffDateFrom(s,month,day))return false;
    if(jobId){
      const targetJob=source.jobs.find(j=>j.id===jobId);
      if(activeJobRulesFrom(source,p.id,wd).some(r=>r.job===jobId&&jobNeedFrom(r,wd)>0) && !staffCanDoJob(source,s,targetJob))return false;
    }
    // 1人につき1日1勤務を基本条件とします。別の勤務時間なら二重配置できる、
    // という抜け道を作らないよう、同日の既配置も候補から外します。
    if(schedule.some(r=>r.date===dateKey(month,day)&&r.staff===s.id&&overlapPatterns(patternFrom(source,r.pattern),p)))return false;
    return true;
  }
  function preferenceScoreFrom(source,s,month,day,p,schedule){
    const order=Array.isArray(source.rules.priority)?source.rules.priority:[];
    const rank=name=>{const i=order.indexOf(name);return i<0?order.length:i;};
    let score=0;
    const weekTarget=Math.max(0,Number(s.days)||0);
    const weekCount=countWeekAssignments(schedule,s.id,dateKey(month,day));

    // ① 希望休を優先：希望休を避ける候補を優先します。希望休は配置不可です。
    if(ruleEnabledFrom(source,"希望休を優先") && hasOffDateFrom(s,month,day)){
      score += 900 * Math.max(1,5-rank("希望休を優先"));
    }

    // ② 希望曜日・時間を優先：基本条件を満たす候補の中でも、
    //    実際の勤務希望との一致を優先する。
    if(ruleEnabledFrom(source,"勤務希望曜日・時間を優先")){
      const wd=weekdayIndex(month,day);
      if(!s.weekdays?.includes(wd)) score += 500 * Math.max(1,5-rank("勤務希望曜日・時間を優先"));
      
      if(s.patterns?.length && !s.patterns.includes(p.id)) score += 400 * Math.max(1,5-rank("勤務希望曜日・時間を優先"));
    }

    // 週勤務日数は「最大勤務数」ではなく、希望する勤務日数に近づけるための優先度です。
    if(ruleEnabledFrom(source,"勤務日数を均等化")) score+=Math.abs(weekTarget-(weekCount+1))*30*Math.max(1,5-rank("勤務日数を均等化"));
    if(ruleEnabledFrom(source,"5日間以上の連勤を避ける")){
      // 月～金など5連勤は許容。6日目以降だけ強く避けます。
      const streak=consecutiveLength(schedule,s.id,dateKey(month,day));
      if(streak>5)score+=(streak-5)*160*Math.max(1,5-rank("5日間以上の連勤を避ける"));
    }
    score+=schedule.filter(r=>r.staff===s.id).length*4;
    return score;
  }
  function ruleEnabledFrom(source,name){return Array.isArray(source.rules.items)&&source.rules.items.some(r=>r.name===name&&r.enabled!==false);}
  function candidateJobBonus(source,s,p,schedule,month,day){
    let bonus=0;
    activeJobRulesFrom(source,p.id,weekdayIndex(month,day)).forEach(rule=>{
      const targetJob=source.jobs.find(j=>j.id===rule.job);
      if(!staffCanDoJob(source,s,targetJob))return;
      const assigned=schedule.filter(r=>r.date===dateKey(month,day)&&r.pattern===p.id&&r.job===rule.job).length;
      if(assigned<jobNeedFrom(rule,weekdayIndex(month,day)))bonus-=120;
    });
    return bonus;
  }

  // 既存の手動変更・候補表示で使用する state ベースの判定。
  function eligible(s,month,day,p,schedule,jobId=null){
    return eligibleFrom(state,s,month,day,p,schedule,jobId);
  }
  function weekCount(s,month,day,schedule){return countWeekAssignments(schedule,s.id,dateKey(month,day));}
  function preferencePenalty(s,month,day,p,schedule){return preferenceScoreFrom(state,s,month,day,p,schedule);}
  function scoreCandidate(s,month,day,p,schedule){return preferencePenalty(s,month,day,p,schedule);}

  /*
   * ① 先に「勤務枠」だけを全営業日分作ります。
   * ② その後で、基本情報・設定を読み込み、枠ごとに配置可能者を探します。
   * ③ 候補者がいれば必ず配置。候補者がいない枠だけ shortage になります。
   */
  function generateMonth(month,sourceInput=null){
    const sourceFinal=sourceInput?normalizeState(clone(sourceInput)):readPlanningSource();
    const schedule=[];
    const configWarnings=[];
    for(let day=1;day<=daysInMonth(month);day++){
      if(isClosedFrom(sourceFinal,month,day))continue;
      const wd=weekdayIndex(month,day),date=dateKey(month,day);
      for(const p of sourceFinal.patterns){
        const need=requirementFrom(sourceFinal,p.id,wd);
        if(need<=0)continue;
        const activeRules=activeJobRulesFrom(sourceFinal,p.id,wd);
        const jobSlots=[];
        activeRules.forEach(rule=>{
          const n=jobNeedFrom(rule,wd);
          for(let i=0;i<n;i++)jobSlots.push({jobId:rule.job});
        });
        const jobSum=jobSlots.length;
        if(activeRules.length && jobSum!==need){
          configWarnings.push({type:"config",date,day,pattern:p.id,message:`${date}（${jpDay(month,day)}） ${p.name}：必要人数 ${need}人 と業務別必要人数合計 ${jobSum}人 が一致していません`});
        }
        while(jobSlots.length<need)jobSlots.push({jobId:""});
        // 必要人数が多い場合は、業務条件付き枠を先に配置し、残りを一般枠として埋めます。
        for(const slot of jobSlots){
          const candidates=sourceFinal.staff.filter(st=>eligibleFrom(sourceFinal,st,month,day,p,schedule,slot.jobId||null));
          candidates.sort((a,b)=>{
            const sa=preferenceScoreFrom(sourceFinal,a,month,day,p,schedule)+candidateJobBonus(sourceFinal,a,p,schedule,month,day);
            const sb=preferenceScoreFrom(sourceFinal,b,month,day,p,schedule)+candidateJobBonus(sourceFinal,b,p,schedule,month,day);
            return sa!==sb?sa-sb:String(a.id).localeCompare(String(b.id));
          });
          if(candidates.length){
            const chosen=candidates[0];
            schedule.push({id:uid("shift"),date,day,pattern:p.id,staff:chosen.id,job:slot.jobId||"",slotNo:schedule.filter(r=>r.date===date&&r.pattern===p.id).length+1});
          }
        }
      }
    }
    auditAndRepairFrom(sourceFinal,month,schedule);
    const finalWarnings=[...configWarnings,...calculateWarningsFrom(sourceFinal,month,schedule)];
    return {schedule,warnings:finalWarnings};
  }

  /*
   * 自動検査・不足修復。
   * 「配置した結果を表示する」だけで終わらず、同じ最新スナップショットで
   * 全勤務枠を再確認し、候補者がいる不足枠を自動で埋めます。
   * 既存の「変更可」表示ロジックには触れず、ここでは配置漏れだけを修復します。
   */
  function auditAndRepairFrom(source,month,schedule){
    const maxPass=3;
    for(let pass=0;pass<maxPass;pass++){
      let repaired=0;
      for(let day=1;day<=daysInMonth(month);day++){
        if(isClosedFrom(source,month,day))continue;
        const date=dateKey(month,day),wd=weekdayIndex(month,day);
        for(const p of source.patterns){
          const need=requirementFrom(source,p.id,wd);
          const activeRules=source.jobRules.filter(r=>r.pattern===p.id);
          // First repair job-specific shortages.
          for(const rule of activeRules){
            const req=jobNeedFrom(rule,wd); if(req<=0)continue;
            let rows=schedule.filter(r=>r.date===date&&r.pattern===p.id);
            let have=rows.filter(r=>r.job===rule.job).length;
            while(have<req && rows.length<need){
              const candidates=source.staff.filter(st=>eligibleFrom(source,st,month,day,p,schedule,rule.job));
              if(!candidates.length)break;
              candidates.sort((a,b)=>schedule.filter(r=>r.staff===a.id).length-schedule.filter(r=>r.staff===b.id).length||String(a.id).localeCompare(String(b.id)));
              const chosen=candidates[0];
              schedule.push({id:uid("shift"),date,day,pattern:p.id,staff:chosen.id,job:rule.job,slotNo:rows.length+1});
              repaired++; rows=schedule.filter(r=>r.date===date&&r.pattern===p.id); have=rows.filter(r=>r.job===rule.job).length;
            }
          }
          let rows=schedule.filter(r=>r.date===date&&r.pattern===p.id);
          let missing=Math.max(0,need-rows.length);
          while(missing>0){
            const candidates=source.staff.filter(st=>eligibleFrom(source,st,month,day,p,schedule));
            if(!candidates.length)break;
            candidates.sort((a,b)=>schedule.filter(r=>r.staff===a.id).length-schedule.filter(r=>r.staff===b.id).length||String(a.id).localeCompare(String(b.id)));
            const chosen=candidates[0];
            schedule.push({id:uid("shift"),date,day,pattern:p.id,staff:chosen.id,job:"",slotNo:rows.length+1});
            repaired++; rows=schedule.filter(r=>r.date===date&&r.pattern===p.id); missing=Math.max(0,need-rows.length);
          }
        }
      }
      if(!repaired)break;
    }
    return schedule;
  }

  function auditConditionViolationsFrom(source,month,schedule){
    const invalid=[];
    for(const r of schedule){
      if(r.date.slice(0,7)!==month){invalid.push(r);continue;}
      const day=Number(r.date.slice(8)),s=staffFrom(source,r.staff),p=patternFrom(source,r.pattern);
      if(!s||!p||isClosedFrom(source,month,day)||!s.weekdays?.includes(weekdayIndex(month,day))||!s.patterns?.includes(p.id)||hasOffDateFrom(s,month,day)){
        invalid.push(r);
      }
    }
    return invalid;
  }

  // 再チェック：最新条件を読み込み、条件漏れ・配置漏れを再検索して必要な人員を配置します。
  // 「別パターンを提案する」機能は現段階では変更せず、条件漏れの再検索に集中します。
  function reloadAndCreateLatest(month){
    syncCurrentForm();
    const source=readPlanningSource();
    const md=getMonthData(month);
    let schedule=Array.isArray(md.schedule)?clone(md.schedule):[];

    // ① 最新条件に照らして現在の配置を検証。条件外の配置だけを除外します。
    schedule=schedule.filter(r=>{
      const s=staffFrom(source,r.staff),p=patternFrom(source,r.pattern);
      if(!s||!p)return false;
      const day=Number(r.date.slice(8));
      if(r.date.slice(0,7)!==month)return false;
      if(isClosedFrom(source,month,day))return false;
      if(!s.weekdays?.includes(weekdayIndex(month,day)))return false;
      if(!s.patterns?.includes(p.id))return false;
      if(hasOffDateFrom(s,month,day))return false;
      return true;
    });

    // 同じ人の同日重複は1件だけ残します。
    const occupied=new Set();
    schedule=schedule.filter(r=>{
      const key=`${r.date}|${r.staff}`;
      if(occupied.has(key))return false;
      occupied.add(key);return true;
    });

    // ② 最新の必要人数を全枠について再検索し、候補者がいる不足枠へ配置します。
    // 既存の正常な配置は維持し、配置漏れだけを自動修復します。
    auditAndRepairFrom(source,month,schedule);

    // ③ 修復後に条件違反が残っていないことを内部でも確認します。
    // 表示側の「変更可」判定は既存ロジックをそのまま利用します。
    const invalidAfterAudit=auditConditionViolationsFrom(source,month,schedule);
    if(invalidAfterAudit.length){
      schedule=schedule.filter(r=>!invalidAfterAudit.includes(r));
      auditAndRepairFrom(source,month,schedule);
    }
    const warnings=[];
    assignJobsFrom(source,month,schedule,warnings);
    md.schedule=schedule;
    md.warnings=calculateWarningsFrom(source,month,schedule);
    md.status="created";
    md.stale=false;
    md.confirmed=false;
    md.generatedAt=new Date().toISOString();
    state.lastGeneratedAt=md.generatedAt;
    return md;
  }

  function assignJobsFrom(source,month,schedule,warnings){
    for(let day=1;day<=daysInMonth(month);day++){
      if(isClosedFrom(source,month,day))continue;
      for(const p of source.patterns){
        const rows=schedule.filter(r=>r.date===dateKey(month,day)&&r.pattern===p.id);
        for(const rule of activeJobRulesFrom(source,p.id,weekdayIndex(month,day))){
          const need=jobNeedFrom(rule,weekdayIndex(month,day));if(need<=0)continue;
          const targetJob=source.jobs.find(j=>j.id===rule.job);
          const capable=rows.filter(r=>!r.job&&staffCanDoJob(source,staffFrom(source,r.staff),targetJob));
          capable.slice(0,need).forEach(r=>{r.job=rule.job;});
          const after=rows.filter(r=>r.job===rule.job&&staffCanDoJob(source,staffFrom(source,r.staff),targetJob)).length;
          if(after<need)warnings.push({type:"job",date:dateKey(month,day),day,pattern:p.id,job:rule.job,message:`${dateKey(month,day)}（${jpDay(month,day)}） ${p.name}：${jobNameFrom(source,rule.job)} 必要 ${need}人 / 配置 ${after}人`});
        }
      }
    }
  }
  function jobNameFrom(source,id){return source.jobs.find(j=>j.id===id)?.name||"業務";}
  function calculateWarningsFrom(source,month,schedule){
    const w=[];
    for(let day=1;day<=daysInMonth(month);day++){
      if(isClosedFrom(source,month,day))continue;
      const wd=weekdayIndex(month,day),date=dateKey(month,day);
      for(const p of source.patterns){
        const rows=schedule.filter(r=>r.date===date&&r.pattern===p.id);
        const need=requirementFrom(source,p.id,wd);
        if(rows.length<need)w.push({type:"shortage",date,day,pattern:p.id,message:`${date}（${jpDay(month,day)}） ${p.name}：必要 ${need}人 / 配置 ${rows.length}人`});
        if(rows.length>need)w.push({type:"over",date,day,pattern:p.id,message:`${date}（${jpDay(month,day)}） ${p.name}：必要 ${need}人 / 配置 ${rows.length}人`});
        const activeRules=source.jobRules.filter(r=>r.pattern===p.id && jobNeedFrom(r,wd)>0);
        const jobSum=activeRules.reduce((a,r)=>a+jobNeedFrom(r,wd),0);
        if(activeRules.length && jobSum!==need)w.push({type:"config",date,day,pattern:p.id,message:`${date}（${jpDay(month,day)}） ${p.name}：必要人数 ${need}人 / 業務別合計 ${jobSum}人`});
        const seen=new Set();
        rows.forEach(r=>{
          if(seen.has(r.staff))w.push({type:"duplicate",date:r.date,day,pattern:p.id,staff:r.staff,message:`${date}（${jpDay(month,day)}） ${p.name}：同じスタッフが重複しています`});
          seen.add(r.staff);
          const s=staffFrom(source,r.staff);
          if(!s)w.push({type:"skill",date,day,pattern:p.id,staff:r.staff,message:`${date}：スタッフが見つかりません`});
          else if(!s.weekdays?.includes(wd))w.push({type:"condition",date,day,pattern:p.id,staff:r.staff,message:`${date}（${jpDay(month,day)}） ${p.name}：${s.name}は勤務曜日外です`});
          else if(!s.patterns?.includes(p.id))w.push({type:"condition",date,day,pattern:p.id,staff:r.staff,message:`${date}（${jpDay(month,day)}） ${p.name}：${s.name}はこの勤務パターンを選択していません`});
          else if(hasOffDateFrom(s,month,day))w.push({type:"condition",date,day,pattern:p.id,staff:r.staff,message:`${date}（${jpDay(month,day)}） ${p.name}：${s.name}は希望休です`});
          if(r.job){
            const rule=activeRules.find(x=>x.job===r.job && jobNeedFrom(x,wd)>0);
            if(rule && !staffCanDoJob(source,s,source.jobs.find(j=>j.id===r.job)))w.push({type:"job",date,day,pattern:p.id,staff:r.staff,job:r.job,message:`${date}（${jpDay(month,day)}） ${p.name}：${s.name}は${jobNameFrom(source,r.job)}の担当条件を満たしていません`});
          }
        });
        activeRules.forEach(rule=>{
          const req=jobNeedFrom(rule,wd); if(req<=0)return;
          const n=rows.filter(r=>r.job===rule.job&&staffCanDoJob(source,staffFrom(source,r.staff),source.jobs.find(j=>j.id===rule.job))).length;
          if(n<req)w.push({type:"job",date,day,pattern:p.id,job:rule.job,message:`${date}（${jpDay(month,day)}） ${p.name}：${jobNameFrom(source,rule.job)} 必要 ${req}人 / 配置 ${n}人`});
        });
      }
    }
    return w;
  }
  function calculateWarnings(month,schedule){return calculateWarningsFrom(state,month,schedule);}
  function hardWarnings(month,schedule){return calculateWarnings(month,schedule).filter(x=>HARD_TYPES.has(x.type));}

  function renderPreparationShift(){
    const box=$("#shiftPreparation");
    if(!box)return;
    const p=preparationStatus();
    box.innerHTML=`<div class="prep-final ${p.all?"ok":"bad"}"><span class="prep-dot">●</span><strong>${p.all?"シフト作成の準備完了":"シフト作成の準備を確認してください"}</strong><small>スタッフ ${state.staff.length}名 / 勤務 ${state.patterns.length}種 / 業務 ${state.jobs.length}種${p.jobRulesOk?"":" / 必要人数不一致"}</small></div>`;
  }

  function renderShift(){
    const month=currentMonth(),md=getMonthData(month),warnings=calculateWarnings(month,md.schedule);md.warnings=warnings;
    $("#targetMonth").value=month;$("#monthStatus").textContent=md.confirmed?"確定済み":md.status==="created"&&!md.stale?"作成済み":md.stale?"要再作成":"未作成";
    const hard=warnings.filter(w=>HARD_TYPES.has(w.type));$("#attentionCount").textContent=`${hard.length}件`;$("#attentionTitle").textContent=hard.length?"調整が必要":"調整はありません";
    const list=$("#attentionList");if(list)list.innerHTML=hard.length?hard.slice(0,80).map(w=>{
      return `<div class="attention-item" role="button" tabindex="0" data-attention-jump="${esc(w.date)}|${esc(w.pattern||"")}"><div><strong>${esc(w.message)}</strong><small>${esc(w.date)}（${esc(jpDay(month,Number(w.date.slice(8))))}）</small></div><span class="attention-info">基本情報で調整してください</span></div>`;
    }).join(""):`<div class="attention-empty">現在、調整が必要な箇所はありません。</div>`;
    list?.querySelectorAll('[data-attention-jump]').forEach(b=>{
      const jump=()=>{const [date,patternId]=b.dataset.attentionJump.split("|");if(patternId)jumpToAdjustment(date,patternId);};
      b.onclick=jump;b.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();jump();}};
    });
    renderScheduleTable(md);renderPreparationShift();renderPreview();refreshShiftSaveState();
  }

  function addCandidates(month,schedule,w){const p=pattern(w.pattern);if(!p)return[];const day=Number(w.date.slice(8)),job=w.type==="job"?w.job:null;return state.staff.filter(s=>eligible(s,month,day,p,schedule,job)).sort((a,b)=>{const ap=preferenceMatches(a,month,day,p),bp=preferenceMatches(b,month,day,p);if(ap!==bp)return ap?-1:1;return scoreCandidate(a,month,day,p,schedule)-scoreCandidate(b,month,day,p,schedule);});}
  function addShiftForWarning(md,date,patternId,jobId,staffId){const month=date.slice(0,7),day=Number(date.slice(8)),p=pattern(patternId),s=staff(staffId);if(!eligible(s,month,day,p,md.schedule,jobId||null)){toast("このスタッフは現在の条件では配置できません");renderShift();return;}md.schedule.push({id:uid("shift"),date,day,pattern:patternId,staff:staffId,job:jobId||""});md.status="created";md.stale=false;md.confirmed=false;md.warnings=calculateWarnings(month,md.schedule);markChanged();renderShift();toast("スタッフを配置しました");}

  function renderScheduleTable(md){
    const table=$("#scheduleTable");if(!table)return;
    const month=currentMonth();
    let h=`<thead><tr><th>日</th>${state.patterns.map(p=>`<th>${esc(p.name)}<br><small>${p.start}～${p.end}</small></th>`).join("")}</tr></thead><tbody>`;
    for(let d=1;d<=daysInMonth(month);d++){
      const date=dateKey(month,d),closed=isClosed(month,d),wd=weekdayIndex(month,d);
      h+=`<tr class="${closed?"holiday-row":""}"><th>${d}日<br><small>${jpDay(month,d)}</small></th>`;
      state.patterns.forEach(p=>{
        const rows=md.schedule.filter(r=>r.date===date&&r.pattern===p.id);
        const need=closed?0:requirementFor(p.id,wd);
        const shortage=Math.max(0,need-rows.length),over=rows.length>need;
        const jobNeeds=closed?[]:state.jobRules.filter(r=>r.pattern===p.id).map(r=>({job:r.job,need:Array.isArray(r.mins)?Number(r.mins[wd])||0:Number(r.min)||0})).filter(x=>x.need>0);
        const jobMissing=jobNeeds.map(j=>({job:j.job,missing:Math.max(0,j.need-rows.filter(r=>r.job===j.job).length)})).filter(x=>x.missing>0);
        const invalidRows=rows.filter(r=>rowHasWarning(month,md.schedule,r));
        const missingGeneric=Math.max(0,shortage-jobMissing.reduce((a,x)=>a+x.missing,0));
        const missingCandidatesForJob=jobMissing.flatMap(j=>{const pp=pattern(p.id);const c=missingCandidates(month,md.schedule,date,pp,j.job);return Array.from({length:j.missing},(_,i)=>({job:j.job,candidates:c,key:`${j.job}-${i}`}));});
        const genericCandidates=missingGeneric>0?missingCandidates(month,md.schedule,date,p):[];
        const hardShortage=(missingGeneric>0&&genericCandidates.length===0)||missingCandidatesForJob.some(x=>x.candidates.length===0)||over||invalidRows.length||jobMissing.some(x=>x.missing>0&&missingCandidates(month,md.schedule,date,p,x.job).length===0);
        const configMismatch=jobNeeds.length>0 && jobNeeds.reduce((a,j)=>a+j.need,0)!==need;
        const adjustment=hardShortage||configMismatch;
        const cellClass=adjustment?("schedule-cell "+(configMismatch?"has-warning":"has-adjustment")):"schedule-cell";
        const alert=configMismatch?"●":(hardShortage?"●":"");
        h+=`<td id="shift-cell-${date}-${p.id}" class="${cellClass}"><div class="schedule-cell-head"><span>${rows.length}/${need}</span>${alert?`<button type="button" class="cell-alert" data-select-adjustment="${date}|${p.id}" aria-label="調整が必要">${alert}</button>`:""}</div>`;
        if(closed)h+=`<span class="empty-shift holiday-label">定休日</span>`;
        else{
          rows.forEach(r=>{
            const rowInvalid=rowHasWarning(month,md.schedule,r),alternatives=replaceCandidates(month,md.schedule,r);
            h+=`<div class="shift-chip-wrap ${rowInvalid?"shift-chip-warning":""}"><span class="shift-chip"><strong>${esc(staffName(r.staff))}</strong>${r.job?` <small>/ ${esc(jobName(r.job))}</small>`:""}</span>${alternatives.length?`<button type="button" class="inline-replace" data-replace-toggle="${r.id}"><span class="change-dot">●</span> 変更可</button><select class="inline-replace-select" data-replace="${r.id}" hidden><option value="">候補を選択</option>${alternatives.map(st=>`<option value="${st.id}">${esc(st.name)}</option>`).join("")}</select>`:""}${rowInvalid?`<span class="adjustment-label">🔴 調整が必要</span><small class="adjustment-info">基本情報で調整してください</small>`:""}</div>`;
          });
          missingCandidatesForJob.forEach(item=>{
            if(item.candidates.length){h+=`<div class="missing-adjust"><span class="candidate-label">● 候補者を選択</span><select class="missing-candidate-select" data-missing-date="${date}" data-missing-pattern="${p.id}" data-missing-job="${item.job}"><option value="">候補者を選択</option>${item.candidates.map(st=>`<option value="${st.id}">${esc(st.name)}</option>`).join("")}</select></div>`;}
            else h+=`<div class="missing-adjust"><span class="adjustment-label">🔴 調整が必要</span><small class="adjustment-info">${esc(jobName(item.job))}の配置可能者がいません</small></div>`;
          });
          for(let n=0;n<missingGeneric;n++){
            if(genericCandidates.length)h+=`<div class="missing-adjust"><span class="candidate-label">● 候補者を選択</span><select class="missing-candidate-select" data-missing-date="${date}" data-missing-pattern="${p.id}" data-missing-job=""><option value="">候補者を選択</option>${genericCandidates.map(st=>`<option value="${st.id}">${esc(st.name)}</option>`).join("")}</select></div>`;
            else h+=`<div class="missing-adjust"><span class="adjustment-label">🔴 調整が必要</span><small class="adjustment-info">基本情報で調整してください</small></div>`;
          }
          if(!rows.length&&!shortage&&!jobMissing.length)h+=`<span class="empty-shift">—</span>`;
          if(configMismatch)h+=`<small class="adjustment-info">必要人数と業務別必要人数の合計を確認してください</small>`;
        }
        h+=`</td>`;
      });
      h+=`</tr>`;
    }
    table.innerHTML=h+"</tbody>";
    table.querySelectorAll('[data-replace-toggle]').forEach(b=>b.onclick=()=>{const sel=table.querySelector(`[data-replace="${b.dataset.replaceToggle}"]`);if(sel){sel.hidden=!sel.hidden;if(!sel.hidden)sel.focus();}});
    table.querySelectorAll('[data-replace]').forEach(e=>e.onchange=()=>{if(e.value)replaceShift(md,e.dataset.replace,e.value);});
    table.querySelectorAll('[data-missing-date]').forEach(e=>e.onchange=()=>{if(e.value)addShiftForWarning(md,e.dataset.missingDate,e.dataset.missingPattern,e.dataset.missingJob||"",e.value);});
    table.querySelectorAll('[data-select-adjustment]').forEach(b=>b.onclick=()=>jumpToAdjustment(...b.dataset.selectAdjustment.split("|")));
  }

  function missingCandidates(month,schedule,date,p){
    const day=Number(date.slice(8));
    return state.staff.filter(s=>eligible(s,month,day,p,schedule)).sort((a,b)=>scoreCandidate(a,month,day,p,schedule)-scoreCandidate(b,month,day,p,schedule));
  }
  function jumpToAdjustment(date,patternId){
    const cell=$(`#shift-cell-${date}-${patternId}`);if(!cell)return;
    cell.scrollIntoView({behavior:"smooth",block:"center",inline:"nearest"});
    cell.classList.add("adjustment-selected");
    clearTimeout(jumpToAdjustment.t);jumpToAdjustment.t=setTimeout(()=>cell.classList.remove("adjustment-selected"),2200);
  }
  function rowHasWarning(month,schedule,row){return hardWarnings(month,schedule).some(w=>w.date===row.date&&w.pattern===row.pattern&&((w.staff&&w.staff===row.staff)||w.type==="job"));}
  function replaceCandidates(month,schedule,row){
    const p=pattern(row.pattern),day=Number(row.date.slice(8));if(!p)return[];
    const base=schedule.filter(r=>r.id!==row.id);
    return state.staff.filter(s=>s.id!==row.staff&&eligible(s,month,day,p,base,row.job||null))
      .sort((a,b)=>scoreCandidate(a,month,day,p,base)-scoreCandidate(b,month,day,p,base)).slice(0,12);
  }
  function replaceShift(md,rowId,newStaff){
    const row=md.schedule.find(r=>r.id===rowId);if(!row)return;
    const month=row.date.slice(0,7),p=pattern(row.pattern),day=Number(row.date.slice(8)),s=staff(newStaff);
    if(!eligible(s,month,day,p,md.schedule.filter(r=>r.id!==rowId),row.job||null)){toast("そのスタッフは条件に合いません");renderShift();return;}
    row.staff=newStaff;md.confirmed=false;md.stale=false;md.status="created";md.warnings=calculateWarnings(month,md.schedule);markChanged();renderShift();toast("配置を変更しました");
  }

  function buildSchedule(month,sourceInput=null){const result=generateMonth(month,sourceInput);const md=getMonthData(month);md.schedule=result.schedule;md.warnings=result.warnings;md.status="created";md.stale=false;md.confirmed=false;md.generatedAt=new Date().toISOString();state.lastGeneratedAt=md.generatedAt;return md;}

  function sampleSchedule(afterLoad=null){
    if(!confirm("サンプル版を読み込みます。6名・2業務・朝9:00～15:00／遅12:00～18:00・全枠必要人数1名のサンプルを読み込みます。現在の入力内容はサンプルに置き換わります。よろしいですか？"))return;
    const month=currentMonth();
    state=createSampleState(month);
    selectedSavedScheduleId="";
    renderBasic();renderSettings();renderOther();renderShift();renderSavedSchedules();markChanged();setShiftSaveButtonState(false);
    showView("basic");
    markChanged();
    toast("指定サンプルを読み込みました。内容を確認してシフト作成してください");
    if(typeof afterLoad==="function")afterLoad();
  }

  function snapshotForSave(month=currentMonth()){
    const copy=clone(state);
    delete copy.savedSchedules;
    // A saved record owns only its saved month, not unrelated transient month work.
    const md=state.months?.[month] ? clone(state.months[month]) : null;
    copy.months={};
    if(md)copy.months[month]=md;
    return copy;
  }
  function saveNamedSchedule(){
    // 対象月の保存データを自動更新します。名前入力は不要です。
    saveCurrentWork(true);
  }

  function loadNamedSchedule(id){
    const rec=state.savedSchedules.find(x=>x.id===id);if(!rec)return;
    if(!confirm(`「${rec.name}」を開きます。現在編集中の内容は、保存していない変更があれば失われます。よろしいですか？`))return;
    const savedList=state.savedSchedules;
    selectedSavedScheduleId=rec.id;
    state=normalizeState(clone(rec.snapshot));
    state.savedSchedules=savedList;
    $("#targetMonth").value=currentMonth();$("#holidayMonth").value=currentMonth();
    renderBasic();renderSettings();renderOther();renderShift();renderSavedSchedules();showView("shift");
    toast(`${rec.name}を読み込みました`);
  }
  function deleteNamedSchedule(id){
    const rec=state.savedSchedules.find(x=>x.id===id);if(!rec)return;
    if(!confirm(`保存済みの「${rec.name}」を削除しますか？`))return;
    state.savedSchedules=state.savedSchedules.filter(x=>x.id!==id);saveState(false);renderSavedSchedules();toast("保存済みシフトを削除しました");
  }
  function renderSavedSchedules(){
    const box=$("#savedScheduleList");
    const select=$("#savedScheduleSelect");
    const status=$("#savedScheduleStatus");
    const ordered=state.savedSchedules.slice().sort((a,b)=>String(b.month).localeCompare(String(a.month)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if(select){
      select.innerHTML=`<option value="">保存したシフトを選択</option>`+ordered.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}（${esc(r.month)}）</option>`).join("");
      if(selectedSavedScheduleId && ordered.some(r=>r.id===selectedSavedScheduleId)) select.value=selectedSavedScheduleId;
    }
    const currentSaved=ordered.find(r=>r.month===currentMonth());
    setShiftSaveButtonState(!!currentSaved);
    if(status){
      if(currentSaved){
        const when=new Date(currentSaved.updatedAt);
        status.textContent=`この月は保存済み：${currentSaved.name}（${when.toLocaleDateString("ja-JP")}）`;
        status.className="saved-shift-status is-saved";
      }else{
        status.textContent="この月はまだ保存されていません";
        status.className="saved-shift-status is-unsaved";
      }
    }
    if(!box)return;
    if(!ordered.length){box.innerHTML='<p class="setting-note">保存済みシフトはありません。</p>';return;}
    box.innerHTML=ordered.map(r=>`<div class="saved-schedule-row"><div><strong>${esc(r.name)}</strong><small>${esc(r.month)} / 最終保存 ${new Date(r.updatedAt).toLocaleDateString("ja-JP")}</small></div><div class="saved-schedule-actions"><button type="button" class="button button-secondary" data-load-schedule="${esc(r.id)}">開く</button><button type="button" class="delete-button" data-delete-schedule="${esc(r.id)}">削除</button></div></div>`).join("");
    box.querySelectorAll('[data-load-schedule]').forEach(b=>b.onclick=()=>loadNamedSchedule(b.dataset.loadSchedule));
    box.querySelectorAll('[data-delete-schedule]').forEach(b=>b.onclick=()=>deleteNamedSchedule(b.dataset.deleteSchedule));
  }

  function newSchedule(){
    const month=currentMonth(),md=getMonthData(month);
    const savedNames=state.savedSchedules.map(x=>x.name).filter(Boolean);
    const savedInfo=savedNames.length?`\n\n保存済みシフト：${savedNames.join("、")}\n※今回の新規作成では保存済みシフトは残ります。`:"\n\n現在、保存済みシフトはありません。";
    const message=md.status==="created" && md.schedule.length
      ? `現在のシフトを新規作成で空にします。残しておきたい場合は、先に「このシフトを保存」してください。${savedInfo}\n\n新規作成を続けますか？`
      : `新規作成にすると、現在のスタッフ・業務・勤務パターン・休日設定を空の状態にします。サンプルから始める場合は「サンプルから作成」を使用してください。${savedInfo}\n\nよろしいですか？`;
    if(!confirm(message))return;
    state={...clone(DEFAULT_STATE),staff:[],jobs:[],patterns:[],coverage:[],jobRules:[],holidays:{weekly:[],exceptions:{}},months:{},currentMonth:month,lastGeneratedAt:"",rules:clone(DEFAULT_STATE.rules),savedSchedules:state.savedSchedules||[]};
    selectedSavedScheduleId="";
    markChanged();setShiftSaveButtonState(false);renderBasic();renderSettings();renderOther();renderShift();renderSavedSchedules();showView("basic");toast("新規作成を開始しました。保存する場合は「設定を保存」を押してください");
  }
  function autoCreate(){
    // V42: 自動作成は「保存済みデータ」ではなく、管理者が現在入力している最新の画面データを使います。
    // ここではlocalStorageへ書き込みません。保存は管理者が明示的に行った時だけです。
    const requestedMonth=$("#targetMonth")?.value || currentMonth();
    const source=readPlanningSource();
    state=normalizeState(clone(source));
    state.currentMonth=requestedMonth;
    const month=requestedMonth;
    showView("shift");
    if(!preparationStatus().all){
      renderBasic();renderSettings();renderOther();renderShift();
      toast("準備状況を確認してください。シフト作成画面で不足項目を確認できます");
      return;
    }
    const md=buildSchedule(month,source);
    renderBasic();renderSettings();renderOther();renderShift();
    const n=hardWarnings(month,md.schedule).length;
    toast(n?`自動作成しました。調整 ${n}件です`:`自動作成しました。調整 0件です`);
  }
  function recheck(){
    // V42: 再チェックも、管理者が現在入力している最新の画面データを使います。
    // 保存済みデータに戻すのではなく、現在の入力を読み直して再配置します。
    const requestedMonth=$("#targetMonth")?.value || currentMonth();
    const source=readPlanningSource();
    state=normalizeState(clone(source));
    state.currentMonth=requestedMonth;
    const month=requestedMonth;
    showView("shift");
    if(!preparationStatus().all){
      renderBasic();renderSettings();renderOther();renderShift();
      toast("準備状況を確認してください。シフト作成画面で不足項目を確認できます");
      return;
    }
    const md=buildSchedule(month,source);
    renderBasic();renderSettings();renderOther();renderShift();
    const n=hardWarnings(month,md.schedule).length;
    toast(n?`再読込しました。最新条件から再配置しました。調整 ${n}件です`:`再読込完了。最新条件から再配置しました。調整 0件です`);
  }

  function confirmSchedule(){syncCurrentForm();const md=getMonthData(currentMonth()),hard=hardWarnings(currentMonth(),md.schedule);if(md.status!=="created"){toast("先にシフトを作成してください");return;}if(hard.length){toast("調整箇所を解消してから確定してください");renderShift();return;}md.confirmed=true;md.stale=false;markChanged();renderShift();toast("シフトを確定しました。保存する場合は「このシフトを保存」またはCtrl+Sを押してください");}

  function buildShareText(){const month=currentMonth(),md=getMonthData(month),lines=[`【AUTOSHIFT ${month.slice(0,4)}年${Number(month.slice(5))}月】`];for(let d=1;d<=daysInMonth(month);d++){const rows=md.schedule.filter(r=>r.date===dateKey(month,d));lines.push(`${d}日（${jpDay(month,d)}）：${isClosed(month,d)?"定休日":rows.map(r=>`${staffName(r.staff)} ${patternName(r.pattern)}`).join("、")||"未配置"}`);}return lines.join("\n");}
  function canShare(){const md=getMonthData(currentMonth());if(md.status!=="created"){toast("先にシフトを作成してください");return false;}if(!md.confirmed){toast("シフトを確定してください");return false;}return true;}
  async function shareSchedule(){if(!canShare())return;const text=buildShareText();if(navigator.share){try{await navigator.share({title:"AUTOSHIFT シフト",text});return;}catch(e){}}try{await navigator.clipboard.writeText(text);toast("シフト内容をコピーしました");}catch(e){toast("共有できませんでした");}}
  function shareLine(){if(!canShare())return;window.open(`https://line.me/R/msg/text/?${encodeURIComponent(buildShareText())}`,"_blank","noopener");}
  function toggleShareMenu(buttonId,menuId){const b=$(buttonId),m=$(menuId);if(!b||!m)return;b.onclick=()=>{const md=getMonthData(currentMonth());if(md.status!=="created"){toast("先にシフトを作成してください");return;}if(!md.confirmed){toast("シフトを確定してください");return;}m.hidden=!m.hidden;};document.addEventListener("click",e=>{if(m.hidden)return;if(!m.contains(e.target)&&e.target!==b)m.hidden=true;});}

  function addStaff(){
    const id=uid("staff");
    state.staff.push({id,name:"",days:0,start:"06:00",end:"18:00",skills:[],patterns:[],weekdays:[],offDates:[]});
    invalidateMonths();
    renderBasic();renderShift();markChanged();
    const input=document.querySelector(`[data-staff="${id}"]`);
    input?.focus();input?.select();
    toast("新しいスタッフを追加しました。名前・勤務条件を入力してください");
  }
  function addJob(){
    const id=uid("job");
    const used=new Set(state.jobs.map(j=>String(j.code||"").toUpperCase()));
    let n=1;while(used.has(String.fromCharCode(65+n-1)))n++;
    const code=String.fromCharCode(65+n-1);
    state.jobs.push({id,code,name:"",content:code,detail:code});
    invalidateMonths();renderSettings();renderBasic();renderShift();markChanged();
    document.querySelector(`[data-job-name="${id}"]`)?.focus();
    toast(`業務コード ${code} を追加しました`);
  }
  function addPattern(){
    const id=uid("pattern");
    state.patterns.push({id,name:`勤務${state.patterns.length+1}`,start:"09:00",end:"17:00"});
    state.coverage.push({id:uid("cov"),pattern:id,mins:[0,0,0,0,0,0,0]});
    invalidateMonths();renderSettings();renderBasic();renderShift();markChanged();
    toast("勤務パターンを追加しました。スタッフの勤務パターンは自動選択されません");
  }

  function setup(){
    state.currentMonth=state.currentMonth||monthNow();$("#targetMonth").value=currentMonth();$("#holidayMonth").value=currentMonth();
    renderNavigation();
    $("#addStaff")?.addEventListener("click",addStaff);$("#newSchedule")?.addEventListener("click",newSchedule);$("#basicNewSchedule")?.addEventListener("click",newSchedule);$("#basicSampleSchedule")?.addEventListener("click",sampleSchedule);$("#addJob")?.addEventListener("click",addJob);$("#addPattern")?.addEventListener("click",addPattern);$("#addJobRule")?.addEventListener("click",addJobRule);$("#sampleSchedule")?.addEventListener("click",sampleSchedule);
    $("#savedScheduleSelect")?.addEventListener("change",e=>{selectedSavedScheduleId=e.target.value||"";if(e.target.value)loadNamedSchedule(e.target.value);});
    $("#autoCreate")?.addEventListener("click",autoCreate);$("#recheck")?.addEventListener("click",recheck);$("#confirmSchedule")?.addEventListener("click",confirmSchedule);$("#saveNamedSchedule")?.addEventListener("click",saveNamedSchedule);$("#saveShiftHeader")?.addEventListener("click",()=>saveCurrentWork(true));
    $("#targetMonth")?.addEventListener("change",()=>{state.currentMonth=$("#targetMonth").value||monthNow();$("#holidayMonth").value=state.currentMonth;renderBasic();renderSettings();renderOther();renderShift();});
    $("#holidayMonth")?.addEventListener("change",()=>{renderHolidayCalendar();renderExceptions();});
    $("#respectDays")?.addEventListener("change",e=>{state.rules.respectDays=e.target.checked;invalidateMonths();renderShift();markChanged();});
    $("#avoidConsecutive")?.addEventListener("change",e=>{state.rules.avoidConsecutive=e.target.checked;invalidateMonths();renderShift();markChanged();});
    $("#respectAvailability")?.addEventListener("change",e=>{state.rules.respectAvailability=e.target.checked;invalidateMonths();renderShift();markChanged();});
    const openPreview=()=>{
      const month=currentMonth();
      const md=getMonthData(month);
      showView("shift");
      // Build a first preview from the ready-to-use sample, but keep an existing
      // hand-adjusted schedule intact when the visitor returns to the preview.
      if(md.status!=="created"&&!md.schedule.length)autoCreate();
      setTimeout(()=>$("#previewPanel")?.scrollIntoView({behavior:"smooth",block:"start"}),180);
    };
    const printCurrent=()=>{showView("shift");setTimeout(()=>window.print(),150)};
    $("#printSchedule")?.addEventListener("click",printCurrent);
    toggleShareMenu("#shareSchedule","#shareMenu");
    toggleShareMenu("#shiftShareSchedule","#shiftShareMenu");
    $("#nativeShare")?.addEventListener("click",()=>shareSchedule());
    $("#shiftNativeShare")?.addEventListener("click",()=>shareSchedule());
    $("#shareLine")?.addEventListener("click",shareLine);
    $("#shiftShareLine")?.addEventListener("click",shareLine);
    $("#previewToggle")?.addEventListener("click",openPreview);
    $("#shiftPreviewToggle")?.addEventListener("click",openPreview);
    $("#startNewSchedule")?.addEventListener("click",newSchedule);
    $("#startSampleSchedule")?.addEventListener("click",sampleSchedule);
    $("#startPreviewDemo")?.addEventListener("click",()=>sampleSchedule(openPreview));
    $("#shiftPrintSchedule")?.addEventListener("click",printCurrent);
    document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();saveCurrentWork(true)}});
    renderBasic();renderSettings();renderOther();renderShift();renderSavedSchedules();
    showWelcome();
  }
  function renderPreview(){
    const box=$("#previewContent"),month=currentMonth(),md=getMonthData(month);if(!box)return;
    const [y,m]=month.split("-").map(Number),firstOffset=(new Date(y,m-1,1).getDay()+6)%7,total=daysInMonth(month),cells=[];
    for(let i=0;i<firstOffset;i++)cells.push(`<div class="preview-day preview-empty" aria-hidden="true"></div>`);
    for(let d=1;d<=total;d++){
      const date=dateKey(month,d),closed=isClosed(month,d),rows=md.schedule.filter(r=>r.date===date);
      let content="";
      if(closed) content=`<span class="preview-closed">休日</span>`;
      else content=state.patterns.map(p=>{
        const need=requirementFor(p.id,weekdayIndex(month,d)),pr=rows.filter(r=>r.pattern===p.id),assigned=pr.length;
        const invalidRows=pr.filter(r=>rowHasWarning(month,md.schedule,r));
        const shortage=assigned<need, over=assigned>need;
        const invalid=invalidRows.length>0||shortage||over;
        const line=pr.length?pr.map(r=>`<span class="preview-staff-name">${esc(staffName(r.staff))}${r.job?` / ${esc(jobName(r.job))}`:""}</span>`).join(""):shortage?`<span class="preview-unassigned">未配置</span>`:"";
        const warningText=invalid?`<small class="preview-adjustment">🔴 調整が必要</small>`:"";
        return `<div class="preview-shift-line ${invalid?"preview-warning":""}"><div class="preview-shift-head"><strong>${esc(patternName(p.id))}</strong><span class="preview-count">${assigned}/${need}</span></div><div class="preview-staff-list">${line}</div>${warningText}</div>`;
      }).join("");
      cells.push(`<div class="preview-day ${closed?"preview-holiday":""}"><header><strong>${d}日（${jpDay(month,d)}）</strong></header><div>${content}</div></div>`);
    }
    const rowsNeeded=Math.ceil((firstOffset+total)/7);while(cells.length<rowsNeeded*7)cells.push(`<div class="preview-day preview-empty" aria-hidden="true"></div>`);
    box.innerHTML=`<div class="preview-title">${month.slice(0,4)}年${Number(month.slice(5))}月</div><div class="preview-weekdays">${DAYS.map(d=>`<span>${d}</span>`).join("")}</div><div class="preview-grid">${cells.join("")}</div>`;
  }
  document.addEventListener("DOMContentLoaded",setup);
})();


