import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker/src/index.js';

const originalFetch = globalThis.fetch;
const adminUser = { id:'test-admin-id', email:'admin@example.test', email_confirmed_at:'2026-01-01T00:00:00Z' };
const env = {
  SUPABASE_URL:'https://supabase.example.test',
  SUPABASE_PUBLISHABLE_KEY:'test-publishable-key',
  SUPABASE_SECRET_KEY:'test-secret-key',
  ADMIN_EMAIL:'admin@example.test',
  ALLOWED_ORIGIN:'https://sonora.example.test',
  AUDIO:{ put:async()=>{ throw new Error('R2 should not be reached by this test'); }, delete:async()=>{} }
};

function jsonResponse(value, status=200, headers={}) {
  return new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json', ...headers}});
}

function authResponse(url) {
  if (url.pathname === '/auth/v1/user') return jsonResponse(adminUser);
  return null;
}

test('admin track PATCH accepts and returns description', async () => {
  const trackId='11111111-1111-4111-8111-111111111111';
  let patched=null;
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname.endsWith(`/rest/v1/tracks`) && init.method==='PATCH') {
      patched=JSON.parse(init.body);
      return jsonResponse([{id:trackId,title:'Test Track',artist:'Test Artist',album:'Test Album',genre:'Rock',description:patched.description,status:'published'}]);
    }
    if (url.pathname.endsWith('/rest/v1/sonora_admin_audit')) return jsonResponse([]);
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const request=new Request(`https://worker.example.test/admin/tracks/${trackId}`, {
      method:'PATCH',
      headers:{Authorization:'Bearer unit-test-token','Content-Type':'application/json',Origin:'https://sonora.example.test'},
      body:JSON.stringify({description:'A new song description\nwith a second line'})
    });
    const response=await worker.fetch(request,env);
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(patched.description,'A new song description\nwith a second line');
    assert.equal(body.track.description,patched.description);
  } finally { globalThis.fetch=originalFetch; }
});

test('server-side duplicate check rejects a repeat before writing to R2', async () => {
  let putCalls=0;
  const duplicateEnv={...env,AUDIO:{put:async()=>{putCalls++;},delete:async()=>{}}};
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname.endsWith('/rest/v1/tracks') && !init.method) {
      return jsonResponse([{id:'existing-track',title:'Test Track',artist:'Test Artist',status:'published'}]);
    }
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const params=new URLSearchParams({title:'Test Track',artist:'Test Artist',filename:'test.mp3'});
    const request=new Request(`https://worker.example.test/admin/upload?${params}`, {
      method:'POST',
      headers:{Authorization:'Bearer unit-test-token','Content-Type':'audio/mpeg',Origin:'https://sonora.example.test'},
      body:Buffer.from('fake-audio-content')
    });
    const response=await worker.fetch(request,duplicateEnv);
    const body=await response.json();
    assert.equal(response.status,409);
    assert.match(body.error,/Possible duplicate blocked/);
    assert.equal(putCalls,0);
  } finally { globalThis.fetch=originalFetch; }
});


test('admin overview includes persisted descriptions in the catalogue payload', async () => {
  const savedDescription='A refreshed catalogue description';
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname === '/auth/v1/health') return jsonResponse({status:'ok'});
    if (url.pathname === '/rest/v1/tracks' && url.searchParams.get('select') === 'id,title,artist,album,genre,description,audio_key,duration_seconds,file_size,mime_type,cover_url,status,created_at') {
      return jsonResponse([{id:'track-1',title:'Test Track',artist:'Test Artist',description:savedDescription,status:'published'}],200,{'Content-Range':'0-0/1'});
    }
    if (url.pathname === '/rest/v1/tracks' || url.pathname.startsWith('/rest/v1/')) {
      if (url.pathname.endsWith('/sonora_admin_play_stats')) return jsonResponse({total_play_events:0,total_play_seconds:0});
      return jsonResponse([],200,{'Content-Range':'0-0/0'});
    }
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  const overviewEnv={...env,AUDIO:{list:async()=>({objects:[],truncated:false}),head:async()=>null}};
  try {
    const request=new Request('https://worker.example.test/admin/overview', {
      headers:{Authorization:'Bearer unit-test-token',Origin:'https://sonora.example.test'}
    });
    const response=await worker.fetch(request,overviewEnv);
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.tracks[0].description,savedDescription);
  } finally { globalThis.fetch=originalFetch; }
});


function uploadRequest() {
  const params=new URLSearchParams({title:'Fresh Song',artist:'Test Artist',filename:'fresh.mp3'});
  return new Request(`https://worker.example.test/admin/upload?${params}`, {
    method:'POST',
    headers:{Authorization:'Bearer unit-test-token','Content-Type':'audio/mpeg',Origin:'https://sonora.example.test'},
    body:Buffer.from('fake-audio-content')
  });
}

test('upload is allowed past the old 12-per-hour limit and is recorded only after success', async () => {
  const events=[];
  const okEnv={...env,AUDIO:{put:async()=>({size:18}),delete:async()=>{}}};
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname.endsWith('/rest/v1/sonora_upload_events')) {
      if (init.method==='POST') { events.push(init.body); return new Response(null,{status:201}); }
      return jsonResponse([], 200, {'Content-Range':'0-11/12'});
    }
    if (url.pathname.endsWith('/rest/v1/tracks') && init.method==='POST') return jsonResponse([{id:'new-id',title:'Fresh Song'}],201);
    if (url.pathname.endsWith('/rest/v1/tracks')) return jsonResponse([]);
    if (url.pathname.endsWith('/rest/v1/sonora_admin_audit')) return jsonResponse([]);
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const response=await worker.fetch(uploadRequest(),okEnv);
    assert.equal(response.status,201);
    assert.equal(events.length,1);
  } finally { globalThis.fetch=originalFetch; }
});

test('a failed upload does not consume the hourly allowance', async () => {
  const events=[];
  const failEnv={...env,AUDIO:{put:async()=>{ throw new Error('R2 down'); },delete:async()=>{}}};
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname.endsWith('/rest/v1/sonora_upload_events')) {
      if (init.method==='POST') { events.push(init.body); return new Response(null,{status:201}); }
      return jsonResponse([], 200, {'Content-Range':'*/0'});
    }
    if (url.pathname.endsWith('/rest/v1/tracks')) return jsonResponse([]);
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const response=await worker.fetch(uploadRequest(),failEnv);
    assert.equal(response.status,500);
    assert.equal(events.length,0);
  } finally { globalThis.fetch=originalFetch; }
});

test('the hourly ceiling still applies when UPLOADS_PER_HOUR is set', async () => {
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname.endsWith('/rest/v1/sonora_upload_events')) return jsonResponse([], 200, {'Content-Range':'0-2/3'});
    if (url.pathname.endsWith('/rest/v1/tracks')) return jsonResponse([]);
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const response=await worker.fetch(uploadRequest(),{...env,UPLOADS_PER_HOUR:'3'});
    assert.equal(response.status,429);
    assert.match((await response.json()).error,/maximum 3 tracks per hour/);
  } finally { globalThis.fetch=originalFetch; }
});

test('album cover route applies one cover to many tracks', async () => {
  let patched=null, filter='';
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  globalThis.fetch=async (input, init={}) => {
    const url=new URL(input);
    const auth=authResponse(url); if(auth)return auth;
    if (url.pathname.endsWith('/rest/v1/tracks') && init.method==='PATCH') { patched=JSON.parse(init.body); filter=url.searchParams.get('id'); return jsonResponse(ids.map(id=>({id}))); }
    if (url.pathname.endsWith('/rest/v1/sonora_admin_audit')) return jsonResponse([]);
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const post=(body)=>new Request('https://worker.example.test/admin/album-cover',{method:'POST',headers:{Authorization:'Bearer t','Content-Type':'application/json',Origin:'https://sonora.example.test'},body:JSON.stringify(body)});
    const ok=await worker.fetch(post({track_ids:ids,cover_url:'https://cdn.example.test/c.jpg'}),env);
    assert.equal(ok.status,200); assert.equal((await ok.json()).updated,2);
    assert.equal(patched.cover_url,'https://cdn.example.test/c.jpg'); assert.equal(filter,`in.(${ids.join(',')})`);
    const bad=await worker.fetch(post({track_ids:['not-a-uuid'],cover_url:'https://x.test/c.jpg'}),env);
    assert.equal(bad.status,400);
    const badUrl=await worker.fetch(post({track_ids:ids,cover_url:'javascript:alert(1)'}),env);
    assert.equal(badUrl.status,400);
  } finally { globalThis.fetch=originalFetch; }
});

test('storage clean-up deletes only old R2 files that no track uses', async () => {
  const old = new Date(Date.now() - 6 * 3600e3), fresh = new Date();
  const objects = [
    { key:'tracks/2026-11-01/used.mp3', size:100, uploaded:old },
    { key:'tracks/2026-11-01/orphan.mp3', size:200, uploaded:old },
    { key:'covers/2026-11-01/used.jpg', size:10, uploaded:old },
    { key:'covers/2026-11-01/orphan.jpg', size:20, uploaded:old },
    { key:'covers/2026-11-24/just-uploaded.jpg', size:30, uploaded:fresh },
    { key:'other/readme.txt', size:1, uploaded:old }
  ];
  const deleted = [];
  const e = { ...env, AUDIO:{ list:async()=>({ objects, truncated:false }), delete:async(keys)=>{ deleted.push(...[].concat(keys)); } } };
  globalThis.fetch = async (input, init={}) => {
    const url = new URL(input); const auth = authResponse(url); if (auth) return auth;
    if (url.pathname.endsWith('/rest/v1/tracks')) return jsonResponse([{ audio_key:'tracks/2026-11-01/used.mp3', cover_url:'https://w.example.test/stream/covers/2026-11-01/used.jpg' }], 200, { 'Content-Range':'0-0/1' });
    if (url.pathname.endsWith('/rest/v1/sonora_admin_audit')) return jsonResponse([]);
    throw new Error(`Unexpected fetch in test: ${init.method||'GET'} ${url}`);
  };
  try {
    const call = (body) => worker.fetch(new Request('https://worker.example.test/admin/cleanup', { method:'POST', headers:{ Authorization:'Bearer t', Origin:'https://sonora.example.test', 'Content-Type':'application/json' }, body:JSON.stringify(body) }), e);
    const preview = await (await call({})).json();
    assert.equal(preview.dry_run, true); assert.equal(preview.unused_songs, 1); assert.equal(preview.unused_covers, 1); assert.equal(preview.skipped_recent, 1); assert.deepEqual(deleted, []);
    const real = await (await call({ dry_run:false })).json();
    assert.equal(real.deleted, 2); assert.deepEqual(deleted.sort(), ['covers/2026-11-01/orphan.jpg', 'tracks/2026-11-01/orphan.mp3']);
  } finally { globalThis.fetch = originalFetch; }
});

test('storage clean-up refuses to delete when the catalogue looks empty', async () => {
  const deleted = [];
  const e = { ...env, AUDIO:{ list:async()=>({ objects:[{ key:'tracks/a.mp3', size:1, uploaded:new Date(0) }], truncated:false }), delete:async(k)=>{ deleted.push(k); } } };
  globalThis.fetch = async (input) => { const url = new URL(input); const auth = authResponse(url); if (auth) return auth; return jsonResponse([], 200, { 'Content-Range':'*/0' }); };
  try {
    const res = await worker.fetch(new Request('https://worker.example.test/admin/cleanup', { method:'POST', headers:{ Authorization:'Bearer t', Origin:'https://sonora.example.test', 'Content-Type':'application/json' }, body:JSON.stringify({ dry_run:false }) }), e);
    assert.equal(res.status, 500); assert.deepEqual(deleted, []);
  } finally { globalThis.fetch = originalFetch; }
});
