const mongoose = require('mongoose');

class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
function bad(message) { throw new ApiError(400, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value) { return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value); }
function text(value, field, required = false, fallback = '') {
    if (value === undefined && !required) return fallback;
    if (typeof value !== 'string' || (required && !value.trim())) bad(`${field} must be a${required ? ' non-empty' : ''} string`);
    return required ? value.trim() : value;
}
function body(req) {
    if (!object(req.body)) bad('Request body must be an object');
    return req.body;
}
async function existing(Model, value, session) {
    if (!id(value)) throw new ApiError(404, `${Model.modelName} not found`);
    const doc = await Model.findById(value).session(session || null);
    if (!doc) throw new ApiError(404, `${Model.modelName} not found`);
    return doc;
}
function json(query, key, fallback) {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string') bad(`${key} must be JSON`);
    try { return JSON.parse(query[key]); } catch { bad(`${key} must be valid JSON`); }
}
function queryObject(query, key) {
    const value = json(query, key, {});
    if (!object(value)) bad(`${key} must be a JSON object`);
    return value;
}
function projection(query) {
    const value = queryObject(query, 'select');
    if (Object.values(value).some(v => v !== 0 && v !== 1)) bad('select values must be 0 or 1');
    const flags = Object.entries(value).filter(([key]) => key !== '_id').map(([,flag]) => flag);
    if (flags.includes(0) && flags.includes(1)) bad('select cannot mix included and excluded fields');
    return value;
}
function rejectScripts(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
        if (['$where', '$function', '$accumulator'].includes(key)) bad('Executable queries are not supported');
        rejectScripts(nested);
    }
}
async function list(Model, req, res) {
    const where = queryObject(req.query, 'where');
    rejectScripts(where);
    const sort = queryObject(req.query, 'sort');
    if (Object.values(sort).some(v => v !== 1 && v !== -1)) bad('sort values must be 1 or -1');
    const select = projection(req.query);
    const skip = json(req.query, 'skip', 0);
    const limit = json(req.query, 'limit', Model.modelName === 'Task' ? 100 : 0);
    const count = json(req.query, 'count', false);
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 0) bad('skip and limit must be non-negative integers');
    if (typeof count !== 'boolean') bad('count must be true or false');
    // Count all filter matches; pagination and projection apply to document lists.
    const data = count ? await Model.countDocuments(where) : await Model.find(where).sort(sort).select(select).skip(skip).limit(limit);
    res.status(200).json({ message: 'OK', data });
}
async function single(Model, req, res) {
    if (!id(req.params.id)) throw new ApiError(404, `${Model.modelName} not found`);
    const data = await Model.findById(req.params.id).select(projection(req.query));
    if (!data) throw new ApiError(404, `${Model.modelName} not found`);
    res.json({ message: 'OK', data });
}
function transaction(callback) { return mongoose.connection.transaction(callback); }
function errors(err, req, res, next) {
    if (res.headersSent) return next(err);
    let status = err instanceof ApiError ? err.status : 500;
    let message = err instanceof ApiError ? err.message : 'Unable to complete the request';
    if (err.code === 11000) { status = 400; message = 'Email is already in use'; }
    else if (['ValidationError', 'CastError', 'StrictModeError'].includes(err.name)) { status = 400; message = 'Invalid field value or type'; }
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'Request body must contain valid JSON'; }
    else if (err.type === 'entity.too.large') { status = 413; message = 'Request body is too large'; }
    else if (req.method === 'GET' && err.name === 'MongoServerError' && [2, 9, 14, 168, 31253, 31254].includes(err.code)) { status = 400; message = 'Invalid query parameters'; }
    res.status(status).json({ message, data: null });
}
module.exports = { ApiError, bad, id, text, body, existing, list, single, transaction, errors };
