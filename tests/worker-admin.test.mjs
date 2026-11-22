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
