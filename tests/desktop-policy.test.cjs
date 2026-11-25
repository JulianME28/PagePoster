const test=require('node:test'),assert=require('node:assert/strict');
test('desktop renderer keeps Node disabled and its context isolated',()=>{
 const {windowPreferences}=require('../desktop/policy.cjs');const p=windowPreferences('C:/app/preload.cjs');assert.equal(p.nodeIntegration,false);assert.equal(p.contextIsolation,true);assert.equal(p.sandbox,true);assert.equal(p.webSecurity,true);assert.equal(p.webviewTag,false);
});
test('backend authorization is scoped to the exact desktop loopback origin',()=>{
 const {authorizeHeaders}=require('../desktop/policy.cjs'),origin='http://127.0.0.1:45678',secret='private-basic-value';
 assert.equal(authorizeHeaders(origin+'/api/lifecycle/projects',{},origin,secret).Authorization,secret);
 for(const url of ['https://external.example/','http://127.0.0.1:45679/','http://127.0.0.1:45678.external.example/','http://user@127.0.0.1:45678/'])assert.equal(Object.values(authorizeHeaders(url,{Authorization:secret},origin,secret)).includes(secret),false,url);
});
test('external links allow only HTTP/S and internal navigation remains in the workspace',()=>{
 const {isWorkspaceURL,isExternalURL}=require('../desktop/policy.cjs'),origin='http://127.0.0.1:45678';
 assert.equal(isWorkspaceURL(origin+'/index.html',origin),true);
 for(const value of ['file:///C:/secret','javascript:alert(1)','data:text/html,hello','https://outside.example/'])assert.equal(isWorkspaceURL(value,origin),false);
 for(const value of ['file:///C:/secret','javascript:alert(1)','data:text/html,hello','ms-settings:about','https://user:password@example.com'])assert.equal(isExternalURL(value),false);
 assert.equal(isExternalURL('https://offer50.example/?ref=123'),true);
});
