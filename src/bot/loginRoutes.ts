import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { verifySignedPayload } from '../crypto/index.js';
import { cancelLogin, startLogin, submitCode, submitPassword } from '../sources/telegram/login.js';

const loginBindings = new Map<string, string>(); // loginId -> userId

function verifyToken(t: string): string | null {
  const { LOGIN_LINK_SECRET } = loadConfig();
  const res = verifySignedPayload(t, LOGIN_LINK_SECRET);
  return res.valid ? res.payload ?? null : null;
}

export async function registerLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', async (req, reply) => {
    const { t } = (req.query as { t?: string }) ?? {};
    const userId = t ? verifyToken(t) : null;
    reply.header('content-type', 'text/html; charset=utf-8');
    if (!userId) return reply.code(400).send(errorPage('Invalid or expired login link.'));
    return reply.send(loginPage(t!));
  });

  app.post('/login/api/start', async (req, reply) => {
    const body = z.object({ t: z.string(), phone: z.string().min(5) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid input' });
    const userId = verifyToken(body.data.t);
    if (!userId) return reply.code(401).send({ error: 'invalid or expired link' });
    try {
      const { loginId, step } = await startLogin(userId, body.data.phone.trim());
      loginBindings.set(loginId, userId);
      return { loginId, step };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/login/api/code', async (req, reply) => {
    const body = z
      .object({ t: z.string(), loginId: z.string(), code: z.string().min(3) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid input' });
    if (!authorize(body.data.t, body.data.loginId)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      const step = await submitCode(body.data.loginId, body.data.code.trim());
      if (step === 'done') loginBindings.delete(body.data.loginId);
      return { step };
    } catch (err) {
      return reply.code(400).send({ error: (err as any)?.errorMessage ?? (err as Error).message });
    }
  });

  app.post('/login/api/password', async (req, reply) => {
    const body = z
      .object({ t: z.string(), loginId: z.string(), password: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid input' });
    if (!authorize(body.data.t, body.data.loginId)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      const step = await submitPassword(body.data.loginId, body.data.password);
      if (step === 'done') loginBindings.delete(body.data.loginId);
      return { step };
    } catch (err) {
      return reply.code(400).send({ error: (err as any)?.errorMessage ?? (err as Error).message });
    }
  });

  app.post('/login/api/cancel', async (req) => {
    const body = z.object({ loginId: z.string() }).safeParse(req.body);
    if (body.success) {
      await cancelLogin(body.data.loginId);
      loginBindings.delete(body.data.loginId);
    }
    return { ok: true };
  });
}

function authorize(t: string, loginId: string): boolean {
  const userId = verifyToken(t);
  return !!userId && loginBindings.get(loginId) === userId;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title></head><body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px"><h2>Telegram login</h2><p style="color:#b00">${message}</p></body></html>`;
}

function loginPage(token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram login</title>
<style>body{font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px}
input{width:100%;padding:10px;margin:6px 0;box-sizing:border-box;font-size:16px}
button{padding:10px 16px;font-size:16px;cursor:pointer}
.hint{color:#666;font-size:13px}.err{color:#b00}.ok{color:#080}fieldset{border:1px solid #ddd;margin:12px 0}</style>
</head><body>
<h2>Connect your Telegram account</h2>
<p class="hint">The code is entered here (not in the bot chat) so Telegram does not invalidate it.</p>
<fieldset id="s-phone"><legend>1. Phone</legend>
<input id="phone" placeholder="+1234567890" autocomplete="tel">
<button onclick="start()">Send code</button></fieldset>
<fieldset id="s-code" disabled><legend>2. Code</legend>
<input id="code" placeholder="12345" inputmode="numeric">
<button onclick="sendCode()">Confirm</button></fieldset>
<fieldset id="s-pass" disabled><legend>3. 2FA password</legend>
<input id="pass" type="password" placeholder="Two-step password">
<button onclick="sendPass()">Confirm</button></fieldset>
<p id="msg"></p>
<script>
const t=${JSON.stringify(token)};let loginId=null;
const $=id=>document.getElementById(id);
function msg(x,cls){$("msg").className=cls||"";$("msg").textContent=x;}
async function post(p,b){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.error||"error");return j;}
async function start(){try{msg("Sending code...");const j=await post("/login/api/start",{t,phone:$("phone").value});loginId=j.loginId;$("s-code").disabled=false;msg("Code sent. Check your Telegram app.");}catch(e){msg(e.message,"err");}}
async function sendCode(){try{msg("Verifying...");const j=await post("/login/api/code",{t,loginId,code:$("code").value});if(j.step==="password_needed"){$("s-pass").disabled=false;msg("Enter your 2FA password.");}else{done();}}catch(e){msg(e.message,"err");}}
async function sendPass(){try{msg("Verifying...");const j=await post("/login/api/password",{t,loginId,password:$("pass").value});if(j.step==="done")done();}catch(e){msg(e.message,"err");}}
function done(){msg("Connected! You can close this page and return to the bot.","ok");$("s-phone").disabled=true;$("s-code").disabled=true;$("s-pass").disabled=true;}
</script></body></html>`;
}
