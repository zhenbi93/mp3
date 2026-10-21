const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
require('dotenv').config({quiet:true});
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');

// Control request ordering within this test process.
function barrier() {
    let release, reached;
    const waiting = new Promise(resolve => release = resolve);
    const arrival = new Promise(resolve => reached = resolve);
    return {release, arrival, async pause() { reached(); await waiting; }};
}
async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Concurrency barrier timed out')),10000);})]); }
    finally {clearTimeout(timer);}
}

test('Assignments stay consistent with concurrent user deletion and rename', async t => {
    const dbName='mp3_test_'+randomUUID().replaceAll('-','').slice(0,24);
    await mongoose.connect(process.env.MONGODB_URI,{dbName,serverSelectionTimeoutMS:15000});
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}/api`;
    const report={cases:[],failed:0};
    t.after(async()=>{
        try {
            assert.equal(mongoose.connection.name,dbName);
            assert.match(dbName,/^mp3_test_[a-f0-9]{24}$/);
            await mongoose.connection.dropDatabase();
            report.temporaryDatabaseRemoved=true;
        } finally {
            await new Promise(resolve=>server.close(resolve));
            await mongoose.disconnect();
            t.diagnostic(`Cases: ${report.cases.length}; failed: ${report.failed}; temporary database removed: ${report.temporaryDatabaseRemoved === true}`);
        }
    });
    await Promise.all([User.init(),Task.init()]);
    let sequence=0;
    async function fixture(method) {
        const key='case'+(++sequence);
        const user=await User.create({name:key,email:key+'@example.com'});
        const task=method==='PUT'?await Task.create({name:key,deadline:'2026-11-03'}):null;
        return {key,user,task};
    }
    async function send(method,url,body) {
        const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
        if(response.status===204){assert.equal(await response.text(),'');return {status:204,body:null};}
        return {status:response.status,body:await response.json()};
    }
    const snapshot=async()=>JSON.stringify({users:await User.find().sort({_id:1}).lean(),tasks:await Task.find().sort({_id:1}).lean()});
    async function check(name,run){await t.test(name,async()=>{try{await run();report.cases.push({name,passed:true});}catch(error){report.failed++;report.cases.push({name,passed:false,message:error.message});throw error;}});}
    for(const method of ['POST','PUT']) {
        for(const completed of [false,true]) {
            await check(`${method} ${completed?'completed':'pending'} assignment retries after user deletion`,async()=>{
                const {key,user,task}=await fixture(method);
                const gate=barrier();
                const original=User.updateOne;
                let paused=false;
                User.updateOne=async function(filter,update,...args){
                    if(!paused && String(filter._id)===String(user._id) && update.$inc?.__v){paused=true;await gate.pause();}
                    return original.call(this,filter,update,...args);
                };
                let assignment;
                try {
                    assignment=send(method,method==='POST'?'/tasks':`/tasks/${task._id}`,{name:key,deadline:'2026-11-03',completed,assignedUser:String(user._id)});
                    await bounded(gate.arrival);
                    assert.equal((await send('DELETE',`/users/${user._id}`)).status,204);
                    const afterDeletion=await snapshot();
                    gate.release();
                    const result=await assignment;
                    assert.equal(result.status,404);
                    assert.equal(result.body.data,null);
                    assert.equal(await snapshot(),afterDeletion,'Rejected assignment must leave all data unchanged');
                } finally {gate.release();if(assignment)await assignment;User.updateOne=original;}
            });
        }
        for(const explicitName of [false,true]) {
            await check(`${method} completed assignment retries after rename (${explicitName?'explicit old name':'inferred name'})`,async()=>{
                const {key,user,task}=await fixture(method);
                const gate=barrier();
                const original=User.updateOne;
                let paused=false;
                User.updateOne=async function(filter,update,...args){
                    if(!paused && String(filter._id)===String(user._id) && update.$inc?.__v){paused=true;await gate.pause();}
                    return original.call(this,filter,update,...args);
                };
                let assignment;
                try {
                    assignment=send(method,method==='POST'?'/tasks':`/tasks/${task._id}`,{name:key,deadline:'2026-11-03',completed:true,assignedUser:String(user._id),...(explicitName?{assignedUserName:user.name}:{})});
                    await bounded(gate.arrival);
                    const renamed=key+' renamed';
                    assert.equal((await send('PUT',`/users/${user._id}`,{name:renamed,email:user.email})).status,200);
                    const afterRename=await snapshot();
                    gate.release();
                    const result=await assignment;
                    if(explicitName){assert.equal(result.status,400);assert.equal(await snapshot(),afterRename);}
                    else {
                        assert.equal(result.status,method==='POST'?201:200);
                        const stored=await Task.findById(result.body.data._id).lean();
                        assert.equal(stored.assignedUser,String(user._id));assert.equal(stored.assignedUserName,renamed);
                        assert.deepEqual((await User.findById(user._id)).pendingTasks.toObject(),[]);
                    }
                } finally {gate.release();if(assignment)await assignment;User.updateOne=original;}
            });
        }
        for(const action of ['DELETE','PUT']) {
            await check(`${method} completed assignment commits before concurrent ${action==='DELETE'?'deletion':'rename'}`,async()=>{
                const {key,user,task}=await fixture(method);
                const gate=barrier();
                const userAttempt=barrier();
                const originalTaskSave=Task.prototype.save;
                const userMethod=action==='DELETE'?'deleteOne':'save';
                const originalUserMethod=User.prototype[userMethod];
                Task.prototype.save=async function(...args){if(this.name===key)await gate.pause();return originalTaskSave.apply(this,args);};
                User.prototype[userMethod]=async function(...args){if(String(this._id)===String(user._id))await userAttempt.pause();return originalUserMethod.apply(this,args);};
                let assignment,change;
                try {
                    assignment=send(method,method==='POST'?'/tasks':`/tasks/${task._id}`,{name:key,deadline:'2026-11-03',completed:true,assignedUser:String(user._id)});
                    await bounded(gate.arrival);
                    change=send(action,`/users/${user._id}`,action==='PUT'?{name:key+' renamed',email:user.email}:undefined);
                    await bounded(userAttempt.arrival);
                    userAttempt.release();
                    gate.release();
                    const [assigned,changed]=await Promise.all([assignment,change]);
                    assert.equal(assigned.status,method==='POST'?201:200);assert.equal(changed.status,action==='DELETE'?204:200);
                    const stored=await Task.findById(assigned.body.data._id).lean();
                    if(action==='DELETE'){assert.equal(stored.assignedUser,'');assert.equal(stored.assignedUserName,'unassigned');}
                    else {assert.equal(stored.assignedUser,String(user._id));assert.equal(stored.assignedUserName,key+' renamed');}
                } finally {
                    gate.release();userAttempt.release();
                    await Promise.allSettled([assignment,change].filter(Boolean));
                    Task.prototype.save=originalTaskSave;User.prototype[userMethod]=originalUserMethod;
                }
            });
        }
    }
});
