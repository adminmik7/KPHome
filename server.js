process.env.TZ = 'Europe/Moscow';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { initDatabase, initKpDatabase, queryAll, queryOne, run, kpQueryAll, kpQueryOne, kpRun } = require('./database');
const app = express();
const PORT = 80;

const CACHE_TTL = 5 * 60 * 1000;
const userCache = new Map();
const filesCache = new Map();

function localNow() {
    return new Date().toLocaleString('sv-SE');
}

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.get('/index.html', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/chat', (req, res) => {
    res.redirect('/chat.html');
});
app.get('/todo', (req, res) => {
    res.redirect('/todo/board.html');
});
app.get('/settings', (req, res) => {
    res.redirect('/aut.html');
});

async function getCachedUsers() {
    const cached = userCache.get('users');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    const users = queryAll('SELECT * FROM users');
    userCache.set('users', { data: users, timestamp: Date.now() });
    return users;
}

async function getCachedFiles() {
    const cached = filesCache.get('files');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    const rows = kpQueryAll('SELECT filename FROM kp_files ORDER BY id');
    const jsonFiles = rows.map(r => r.filename);
    filesCache.set('files', { data: jsonFiles, timestamp: Date.now() });
    return jsonFiles;
}

app.get('/api/users', async (req, res) => {
    try {
        const users = await getCachedUsers();
        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения db.json' });
    }
});

app.post('/api/auth/verify', async (req, res) => {
    try {
        const { login, password } = req.body;
        if (!login || !password) {
            return res.status(400).json({ success: false, message: 'Не указан логин или пароль' });
        }
        const user = queryOne('SELECT * FROM users WHERE login = ?', [login]);
        if (user && bcrypt.compareSync(password, user.passw)) {
            res.json({ success: true, user: { login: user.login, role: user.role } });
        } else {
            res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка авторизации' });
    }
});

app.post('/api/users', async (req, res) => {
    const newUsers = req.body.users;
    if (!newUsers || !Array.isArray(newUsers)) {
        return res.status(400).json({ error: 'users должен быть массивом' });
    }
    try {
        run('DELETE FROM users');
        for (const u of newUsers) {
            let passw = u.passw;
            if (passw && !passw.startsWith('$2')) {
                passw = hashPassword(passw);
            }
            run(
                `INSERT INTO users (login, passw, role, executor, phone, email) VALUES (?, ?, ?, ?, ?, ?)`,
                [u.login, passw, u.role || 'user', u.executor || '', u.phone || '', u.email || '']
            );
        }
        userCache.delete('users');
        res.json({ success: true });
    } catch (err) {
        console.error('[POST /api/users] ERROR:', err.message);
        res.status(500).json({ error: 'Ошибка сохранения пользователей' });
    }
});

app.post('/api/env', async (req, res) => {
    const envData = req.body;
    if (!envData || !envData.conditions) {
        return res.status(400).json({ error: 'Отсутствует поле conditions' });
    }
    try {
        for (const [key, values] of Object.entries(envData.conditions)) {
            run(
                'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                [`conditions_${key}`, JSON.stringify(values)]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка записи conditions' });
    }
});

app.get('/api/env', async (req, res) => {
    try {
        const rows = queryAll("SELECT key, value FROM settings WHERE key LIKE 'conditions_%'");
        const conditions = {};
        for (const row of rows) {
            const key = row.key.replace('conditions_', '');
            conditions[key] = JSON.parse(row.value);
        }
        res.json({ conditions });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения conditions' });
    }
});

app.get('/api/endpoint', async (req, res) => {
    try {
        let ep = queryOne('SELECT url, enabled FROM endpoint WHERE id = 1');
        if (!ep) {
            run('INSERT INTO endpoint (id, url, enabled) VALUES (1, ?, ?)', ['', 0]);
            ep = { url: '', enabled: 0 };
        }
        res.json({ success: true, endpoint: { url: ep.url, enabled: !!ep.enabled } });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка чтения endpoint' });
    }
});

app.post('/api/endpoint', async (req, res) => {
    const { url, enabled } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Отсутствует URL' });
    }
    try {
        run('INSERT OR REPLACE INTO endpoint (id, url, enabled) VALUES (1, ?, ?)', [url, enabled ? 1 : 0]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка записи endpoint' });
    }
});

app.get('/api/files', async (req, res) => {
    try {
        const fileList = await getCachedFiles();

        const fileDetails = fileList.map(filename => {
            const row = kpQueryOne('SELECT filename, content, created_at, updated_at FROM kp_files WHERE filename = ?', [filename]);
            if (!row) return null;
            const detail = {
                name: row.filename,
                date: row.created_at,
                modifiedAt: row.updated_at
            };
            try {
                const json = JSON.parse(row.content);
                if (json.createdBy) detail.createdBy = json.createdBy;
                    if (json.meta) {
                    if (json.meta.customer) detail.customer = json.meta.customer;
                    if (json.meta.date) detail.fileDate = json.meta.date;
                    if (json.meta.kpNumber) detail.kpNumber = json.meta.kpNumber;
                    if (json.meta.contactDate) detail.contactDate = json.meta.contactDate;
                }
                detail.size = row.content.length;
            } catch (_) {}
            return detail;
        });

        res.json({ success: true, files: fileDetails.filter(Boolean) });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка чтения файлов' });
    }
});

app.get('/api/files/:filename', async (req, res) => {
    const filename = req.params.filename;
    try {
        const row = kpQueryOne('SELECT content FROM kp_files WHERE filename = ?', [filename]);
        if (!row) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }
        res.json({ success: true, data: JSON.parse(row.content) });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка чтения файла' });
    }
});

app.put('/api/files/:filename', async (req, res) => {
    const filename = req.params.filename;
    const data = req.body;

    if (!data || !data.meta) {
        return res.status(400).json({ success: false, error: 'Отсутствуют данные' });
    }

    const filteredData = JSON.parse(JSON.stringify(data));
    if (filteredData.logo && filteredData.logo.startsWith('data:image/')) {
        filteredData.logo = '';
    }
    if (filteredData.signature && filteredData.signature.startsWith('data:image/')) {
        filteredData.signature = '';
    }

    try {
        const existing = kpQueryOne('SELECT id FROM kp_files WHERE filename = ?', [filename]);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }
        kpRun('UPDATE kp_files SET content = ?, updated_at = ? WHERE filename = ?',
            [JSON.stringify(filteredData, null, 2), localNow(), filename]);
        filesCache.delete('files');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка записи файла' });
    }
});

app.delete('/api/files/:filename', async (req, res) => {
    const filename = req.params.filename;
    try {
        const existing = kpQueryOne('SELECT id FROM kp_files WHERE filename = ?', [filename]);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Файл не найден' });
        }
        kpRun('DELETE FROM kp_files WHERE filename = ?', [filename]);
        filesCache.delete('files');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка удаления файла' });
    }
});

app.post('/api/files', async (req, res) => {
    const data = req.body;
    if (!data || !data.meta) {
        return res.status(400).json({ success: false, error: 'Отсутствуют данные' });
    }

    const filteredData = JSON.parse(JSON.stringify(data));
    if (filteredData.logo && filteredData.logo.startsWith('data:image/')) {
        filteredData.logo = '';
    }
    if (filteredData.signature && filteredData.signature.startsWith('data:image/')) {
        filteredData.signature = '';
    }

    const clean = s => String(s || '').trim().replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    const customer = clean(filteredData.meta.customer) || 'Без_заказчика';
    const kpNum = clean(filteredData.meta.kpNumber) || '1';
    const date = filteredData.meta.date || localNow().split('T')[0];
    const fileName = `${customer}_${kpNum}_${date}.json`;

    try {
        const now = localNow();
        const existing = kpQueryOne('SELECT id FROM kp_files WHERE filename = ?', [fileName]);
        if (existing) {
            kpRun('UPDATE kp_files SET content = ?, updated_at = ? WHERE filename = ?',
                [JSON.stringify(filteredData, null, 2), now, fileName]);
        } else {
            kpRun('INSERT INTO kp_files (filename, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
                [fileName, JSON.stringify(filteredData, null, 2), now, now]);
        }
        filesCache.delete('files');
        res.json({ success: true, filename: fileName });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка записи файла' });
    }
});

app.get('/api/todo', async (req, res) => {
    try {
        const rows = queryAll('SELECT filename, status, contactDate FROM todo ORDER BY id');
        res.json({ success: true, todo: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка чтения todo' });
    }
});

app.post('/api/todo', async (req, res) => {
    const todoData = req.body;
    try {
        run('DELETE FROM todo');
        if (Array.isArray(todoData)) {
            for (const item of todoData) {
                run(
                    'INSERT INTO todo (filename, status, contactDate) VALUES (?, ?, ?)',
                    [item.filename, item.status || 'pending', item.contactDate || null]
                );
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка записи todo' });
    }
});

app.get('/api/tasks', (req, res) => {
    const login = req.query.login || '';
    let tasks = queryAll('SELECT * FROM tasks');
    if (login) {
        const user = queryOne('SELECT * FROM users WHERE login = ?', [login]);
        if (!user) return res.status(401).json({ success: false, error: 'Пользователь не найден' });
        if (user.role !== 'admin') {
            tasks = tasks.filter(function(t) {
                if (t.userId === login) return true;
                var executors = t.executor;
                if (Array.isArray(executors)) return executors.indexOf(login) !== -1;
                if (typeof executors === 'string' && executors === login) return true;
                return false;
            });
        }
    }
    res.json({ success: true, tasks: tasks.sort((a, b) => {
        var ua = a.updatedAt || a.createdAt;
        var ub = b.updatedAt || b.createdAt;
        return new Date(ub) - new Date(ua);
    }) });
});

app.get('/api/tasks/count', (req, res) => {
    const login = req.query.login || '';
    if (!login) return res.status(401).json({ success: false, error: 'Не указан логин' });
    const user = queryOne('SELECT * FROM users WHERE login = ?', [login]);
    if (!user) return res.status(401).json({ success: false, error: 'Пользователь не найден' });
    let tasks = queryAll('SELECT * FROM tasks');
    tasks = tasks.filter(function(t) {
        if (t.userId === login) return true;
        var executors = t.executor;
        if (Array.isArray(executors)) return executors.indexOf(login) !== -1;
        if (typeof executors === 'string' && executors === login) return true;
        return false;
    });
    const todoCount = tasks.filter(t => t.status === 'todo').length;
    res.json({ success: true, count: todoCount });
});

app.post('/api/tasks', (req, res) => {
    const login = req.body.login || '';
    if (!login) return res.status(401).json({ success: false, error: 'Не указан логин' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ success: false, error: 'Заголовок обязателен' });
    const task = {
        id,
        title,
        description: (req.body.description || '').trim(),
        status: req.body.status || 'todo',
        userId: req.body.userId || login,
        executor: req.body.executor || '',
        createdAt: req.body.createdAt || localNow()
    };
    run(
        'INSERT INTO tasks (id, title, description, status, userId, executor, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [task.id, task.title, task.description, task.status, task.userId, task.executor, task.createdAt]
    );
    const allTasks = queryAll('SELECT * FROM tasks');
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'tasks_updated', tasks: allTasks }));
        }
    });
    res.json({ success: true, task });
});

app.put('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;
    const existing = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!existing) return res.status(404).json({ success: false, error: 'Задача не найдена' });
    const updates = req.body;
    const title = updates.title !== undefined ? updates.title.trim() : existing.title;
    const description = updates.description !== undefined ? updates.description.trim() : existing.description;
    const status = updates.status !== undefined ? updates.status : existing.status;
    const executor = updates.executor !== undefined ? updates.executor : existing.executor;
    const updatedAt = updates.updatedAt || localNow();
    run(
        'UPDATE tasks SET title=?, description=?, status=?, executor=?, updatedAt=? WHERE id=?',
        [title, description, status, executor, updatedAt, taskId]
    );
    const allTasks = queryAll('SELECT * FROM tasks');
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'tasks_updated', tasks: allTasks }));
        }
    });
    res.json({ success: true, task: queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]) });
});

app.delete('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;
    const existing = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!existing) return res.status(404).json({ success: false, error: 'Задача не найдена' });
    run('DELETE FROM tasks WHERE id = ?', [taskId]);
    const allTasks = queryAll('SELECT * FROM tasks');
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'tasks_updated', tasks: allTasks }));
        }
    });
    res.json({ success: true });
});

const CHAT_IMAGES_DIR = path.join(__dirname, 'public', 'img', 'chat-images');
if (!fs.existsSync(CHAT_IMAGES_DIR)) {
    fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
}

app.get('/img/chat-images/:filename', (req, res) => {
    const filePath = path.join(CHAT_IMAGES_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }
    res.sendFile(filePath);
});

function parseMultipartBody(buffer, contentType) {
    const parts = contentType.split(';');
    const match = parts[1]?.match(/boundary=(.+)/);
    if (!match) return null;
    const boundary = '\r\n--' + match[1].trim();
    const boundaryBuf = Buffer.from(boundary);
    const endBoundary = Buffer.from('\r\n--' + match[1].trim() + '--');

    let endPos = buffer.indexOf(endBoundary);
    if (endPos === -1) return null;

    let pos = 0;
    let result = null;
    let mimeType = null;

    while (pos < endPos) {
        const nextBoundary = buffer.indexOf(boundaryBuf, pos);
        if (nextBoundary === -1 || nextBoundary > endPos) break;

        const headerEnd = buffer.indexOf('\r\n\r\n', pos);
        if (headerEnd === -1) { pos = nextBoundary; continue; }

        const headerSection = buffer.slice(pos, headerEnd).toString('latin1');
        const dispositionMatch = headerSection.match(/filename\s*=\s*"([^"]+)"/i);

        if (dispositionMatch && headerSection.toLowerCase().includes('name="image"')) {
            const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
            mimeType = ctMatch ? ctMatch[1].trim() : 'image/jpeg';

            const dataStart = headerEnd + 4;
            let dataEnd = buffer.indexOf(boundaryBuf, dataStart);
            if (dataEnd === -1) dataEnd = endPos;
            if (buffer[dataEnd - 2] === 0x0D && buffer[dataEnd - 1] === 0x0A) {
                dataEnd -= 2;
            }
            result = buffer.slice(dataStart, dataEnd);
            break;
        }

        pos = nextBoundary;
    }

    return { data: result, mimeType: mimeType };
}

function getImageExtension(mimeType) {
    const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    return map[mimeType] || 'jpg';
}

app.post('/api/chat/image', (req, res) => {
    let chunks = [];
    req.on('data', chunk => {
        chunks.push(chunk);
    });
    req.on('end', () => {
        try {
            const buffer = Buffer.concat(chunks);
            const contentType = req.headers['content-type'] || '';
            const login = req.headers['x-user-login'] || 'anonymous';
            const { data: imageBuffer, mimeType } = parseMultipartBody(buffer, contentType);

            if (!imageBuffer || imageBuffer.length === 0) {
                return res.status(400).json({ success: false, error: 'Не удалось извлечь изображение' });
            }

            const ext = getImageExtension(mimeType);
            const filename = `img_${login}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const filePath = path.join(CHAT_IMAGES_DIR, filename);
            fs.writeFile(filePath, imageBuffer, (err) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Ошибка загрузки' });
                }
                res.json({ success: true, url: `/img/chat-images/${filename}` });
            });
        } catch (e) {
            console.error('[Image Upload] Error:', e.message);
            res.status(500).json({ success: false, error: 'Ошибка загрузки' });
        }
    });
});

app.delete('/api/chat/image/:filename', (req, res) => {
    const filePath = path.join(CHAT_IMAGES_DIR, req.params.filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Ошибка удаления' });
    }
});

app.get('/api/chat', (req, res) => {
    const before = req.query.before || null;
    const limit = parseInt(req.query.limit) || 1000;
    let messages;
    if (before) {
        messages = queryAll('SELECT * FROM messages WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT ?', [before, limit]);
    } else {
        messages = queryAll('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?', [limit]);
    }
    messages.reverse();
    res.json({ success: true, messages });
});

app.post('/api/chat', (req, res) => {
    const { type, from, to, text } = req.body;
    if (!type || !from || !text) {
        return res.status(400).json({ success: false, error: 'Недостаточно данных' });
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const timestamp = localNow();
    run(
        'INSERT INTO messages (id, type, channel, from_user, to_user, text, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, type, null, from, to || null, text, timestamp]
    );
    const msg = { id, type, from, to: to || null, text, timestamp };
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'message', data: msg }));
        }
    });
    res.json({ success: true, message: msg });
});

app.delete('/api/chat/private/:user', (req, res) => {
    const targetUser = req.params.user;
    run('DELETE FROM messages WHERE type = ? AND (from_user = ? OR to_user = ?)', ['private', targetUser, targetUser]);
    res.json({ success: true });
});

function extractImageUrls(text) {
    const urls = [];
    const regex = /\/img\/chat-images\/img_[^"'\s]+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        urls.push(match[0].split('/').pop());
    }
    return urls;
}

app.delete('/api/chat/:id', (req, res) => {
    const messageId = req.params.id;
    const msg = queryOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) {
        return res.status(404).json({ success: false, error: 'Сообщение не найдено' });
    }
    const imageFiles = extractImageUrls(msg.text);
    imageFiles.forEach(filename => {
        const filePath = path.join(CHAT_IMAGES_DIR, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });
    run('DELETE FROM messages WHERE id = ?', [messageId]);
    res.json({ success: true });
});

app.get('/api/channels', (req, res) => {
    const channels = queryAll('SELECT * FROM channels');
    res.json({ success: true, channels });
});

app.post('/api/channels', (req, res) => {
    const { name, createdBy } = req.body;
    if (!name || !createdBy) {
        return res.status(400).json({ success: false, error: 'Недостаточно данных' });
    }
    const id = 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const createdAt = localNow();
    run('INSERT INTO channels (id, name, createdBy, createdAt) VALUES (?, ?, ?, ?)', [id, name.trim(), createdBy, createdAt]);
    res.json({ success: true, channel: { id, name: name.trim(), createdBy, createdAt } });
});

app.delete('/api/channels/:id', (req, res) => {
    const channelId = req.params.id;
    const channel = queryOne('SELECT * FROM channels WHERE id = ?', [channelId]);
    if (!channel) {
        return res.status(404).json({ success: false, error: 'Канал не найден' });
    }
    run('DELETE FROM channels WHERE id = ?', [channelId]);
    res.json({ success: true });
});

app.patch('/api/channels/:id', (req, res) => {
    const channelId = req.params.id;
    const { name } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Название не может быть пустым' });
    }
    const channel = queryOne('SELECT * FROM channels WHERE id = ?', [channelId]);
    if (!channel) {
        return res.status(404).json({ success: false, error: 'Канал не найден' });
    }
    run('UPDATE channels SET name = ? WHERE id = ?', [name.trim(), channelId]);
    res.json({ success: true, channel: { id: channelId, name: name.trim() } });
});

const sharedHttpServer = http.createServer(app);
const wss = new WebSocketServer({ server: sharedHttpServer });

const connectedUsers = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'login') {
                const users = getCachedUsersSync();
                let user;
                if (!msg.passw || msg.passw === '') {
                    user = users.find(u => u.login === msg.login);
                } else {
                    user = users.find(u => u.login === msg.login && bcrypt.compareSync(msg.passw, u.passw));
                }
                if (user) {
                    connectedUsers.set(ws, user.login);
                    ws.send(JSON.stringify({ type: 'logged_in', login: user.login, role: user.role }));
                    broadcastUserList();
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверный логин или пароль' }));
                }
            } else if (msg.type === 'chat_message') {
                const login = connectedUsers.get(ws);
                if (!login) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                    return;
                }
                const users = getCachedUsersSync();
                const user = users.find(u => u.login === login);
                if (!user) return;
                const chatMsg = {
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                    type: msg.channelId ? 'channel' : (msg.to ? 'private' : 'general'),
                    channel: msg.channelId || null,
                    from: login,
                    to: msg.to || null,
                    text: msg.text,
                    timestamp: localNow()
                };
                run(
                    'INSERT INTO messages (id, type, channel, from_user, to_user, text, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [chatMsg.id, chatMsg.type, chatMsg.channel, chatMsg.from, chatMsg.to, chatMsg.text, chatMsg.timestamp]
                );
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({ type: 'message', data: chatMsg }));
                    }
                });
            } else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) {
            console.error('[WS] Error:', e.message);
        }
    });

    ws.on('close', () => {
        const login = connectedUsers.get(ws);
        if (login) {
            connectedUsers.delete(ws);
            broadcastUserList();
        }
    });
});

function broadcastUserList() {
    const list = Array.from(connectedUsers.values()).map(login => ({ login, role: 'user' }));
    const payload = JSON.stringify({ type: 'user_list', users: list });
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
}

function getCachedUsersSync() {
    const cached = userCache.get('users');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    const users = queryAll('SELECT * FROM users');
    userCache.set('users', { data: users, timestamp: Date.now() });
    return users;
}

const SALT_ROUNDS = 10;

function hashPassword(plain) {
    return bcrypt.hashSync(plain, SALT_ROUNDS);
}

(async () => {
    await initDatabase();
    await initKpDatabase();

    sharedHttpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`HTTP + WebSocket server started on port ${PORT} (all interfaces)`);
    });
})();
