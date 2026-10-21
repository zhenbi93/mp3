const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
require('dotenv').config({quiet:true});
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');

test('Duplicate emails and invalid references', async t => {
    const dbName = 'mp3_test_' + randomUUID().replaceAll('-', '').slice(0,24);
    await mongoose.connect(process.env.MONGODB_URI,{dbName,serverSelectionTimeoutMS:15000});
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const report = {cases:[],failed:0,unchangedDatabaseChecks:0};
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
    const [a,b] = await User.create([{name:'Alice',email:'alice@example.com'},{name:'Bob',email:'bob@example.com'}]);
    const [pending,completed] = await Task.create([{name:'Pending',deadline:new Date(),assignedUser:String(a._id),assignedUserName:a.name},{name:'Completed',deadline:new Date(),completed:true,assignedUser:String(a._id),assignedUserName:a.name}]);
    await User.updateOne({_id:a._id},{$set:{pendingTasks:[String(pending._id)]}});
    async function snapshot(){return JSON.stringify({users:await User.find().sort({_id:1}).lean(),tasks:await Task.find().sort({_id:1}).lean()});}
    async function request(method,url,body){
        const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
        const result=await response.json();
        assert.equal(typeof result.message,'string');assert.ok(Object.hasOwn(result,'data'));
        assert.doesNotMatch(result.message,/Mongoose|MongoServer|CastError|E11000/i);
        return {status:response.status,...result};
    }
    async function check(name,run){await t.test(name,async()=>{try{await run();report.cases.push({name,passed:true});}catch(error){report.failed++;report.cases.push({name,passed:false,message:error.message});throw error;}});}
    async function rejected(name,method,url,body,status){
        await check(name,async()=>{
            const before=await snapshot();
            const result=await request(method,url,body);
            assert.equal(result.status,status,result.message);assert.equal(result.data,null);
            assert.equal(await snapshot(),before,'Failed request must not modify either collection');
            report.unchangedDatabaseChecks++;
        });
    }
    await rejected('POST duplicate email', 'POST','/users',{name:'Duplicate',email:a.email},400);
    await rejected('PUT email belonging to another user','PUT',`/users/${b._id}`,{name:b.name,email:a.email,pendingTasks:[String(pending._id)]},400);
    await rejected('Whitespace does not bypass email uniqueness','POST','/users',{name:'Duplicate',email:' '+a.email+' '},400);
    await check('PUT keeping own email is allowed',async()=>{
        const before=await snapshot();
        assert.equal((await request('PUT',`/users/${b._id}`,{name:b.name,email:b.email})).status,200);
        assert.equal(await snapshot(),before);
    });
    const missing='000000000000000000000001';
    for(const method of ['POST','PUT']){
        const userPath=method==='POST'?'/users':`/users/${b._id}`;
        const user={name:b.name,email:method==='POST'?'new@example.com':b.email};
        const taskPath=method==='POST'?'/tasks':`/tasks/${pending._id}`;
        const task={name:'Task',deadline:'2026-11-03'};
        await rejected(`${method} malformed pending task id`,method,userPath,{...user,pendingTasks:['invalid']},400);
        await rejected(`${method} nonexistent pending task`,method,userPath,{...user,pendingTasks:[missing]},404);
        await rejected(`${method} completed task in pendingTasks`,method,userPath,{...user,pendingTasks:[String(completed._id)]},400);
        await rejected(`${method} completed task precedes missing reference`,method,userPath,{...user,pendingTasks:[String(completed._id),missing]},400);
        await rejected(`${method} bad id takes priority over missing reference`,method,userPath,{...user,pendingTasks:[missing,'invalid']},400);
        await rejected(`${method} malformed assigned user id`,method,taskPath,{...task,assignedUser:'invalid'},400);
        await rejected(`${method} nonexistent assigned user`,method,taskPath,{...task,assignedUser:missing},404);
        await rejected(`${method} mismatched assigned user name`,method,taskPath,{...task,assignedUser:String(a._id),assignedUserName:'Wrong'},400);
    }
    await rejected('Missing URL user precedes duplicate email and bad reference','PUT',`/users/${missing}`,{name:'Wrong',email:a.email,pendingTasks:['invalid']},404);
    await rejected('Missing URL task precedes bad assignment','PUT',`/tasks/${missing}`,{name:'Wrong',deadline:'invalid',assignedUser:'invalid'},404);
    await check('Concurrent duplicate creation permits exactly one user',async()=>{
        const before=await snapshot();
        const email='race@example.com';
        try {
            const results=await Promise.all([request('POST','/users',{name:'Race A',email}),request('POST','/users',{name:'Race B',email})]);
            assert.deepEqual(results.map(result=>result.status).sort(),[201,400]);
            assert.equal(await User.countDocuments({email}),1);
            assert.equal(results.find(result=>result.status===400).data,null);
        } finally { await User.deleteMany({email}); }
        assert.equal(await snapshot(),before,'Rejected concurrent request must not change other documents');
    });
});
