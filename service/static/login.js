'use strict';
const form=document.getElementById('loginForm'),password=document.getElementById('password'),toggle=document.getElementById('passwordToggle'),submit=document.getElementById('loginSubmit'),error=document.getElementById('loginError'),buttonText=document.getElementById('loginButtonText');
toggle.addEventListener('click',()=>{
  const visible=password.type==='password';password.type=visible?'text':'password';
  toggle.textContent=visible?'숨기기':'보기';toggle.setAttribute('aria-label',visible?'암호 숨기기':'암호 보기');toggle.setAttribute('aria-pressed',String(visible));
});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(submit.disabled)return;
  submit.disabled=true;buttonText.textContent='접속 확인 중…';error.hidden=true;
  try{
    const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:password.value,next:new URLSearchParams(location.search).get('next')||'/'})});
    const value=await response.json();
    if(!response.ok){error.textContent=value.error||'접속 정보를 확인해 주세요.';error.hidden=false;if(response.status===401){password.value='';password.focus();}return;}
    const target=new URL(value.redirect||'/',location.origin);
    if(target.origin!==location.origin)throw Error('Invalid destination');
    password.value='';location.assign(target.pathname+target.search+target.hash);
  }catch{
    error.textContent='연결이 잠시 끊겼어요. 잠시 후 다시 접속해 주세요.';error.hidden=false;
  }finally{submit.disabled=false;buttonText.textContent='접속하기';}
});
