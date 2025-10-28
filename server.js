const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path'); 
const multer = require('multer');
const markdownit = require('markdown-it'); // Markdown kütüphanesini dahil et
const app = express();
const server = http.createServer(app);
// 💡 DEĞİŞİKLİK: CORS ayarı artık gerekli değil, ancak gelecekteki esneklik için kalabilir.
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = 3000;
const DEFAULT_CHANNEL_NAME = 'genel';

// Dosya yükleme dizinleri
const uploadsDir = path.join(__dirname, 'uploads');
const avatarsDir = path.join(uploadsDir, 'avatars'); // Avatarlar için
const filesDir = path.join(uploadsDir, 'files'); // Dosya gönderileri için
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
if (!FIREBASE_WEB_API_KEY) {
    console.error("KRİTİK HATA: FIREBASE_WEB_API_KEY bulunamadı!");
}
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir);
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir);
// Express'in bu klasörleri public olarak sunmasını sağlıyoruz
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const avatarStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, avatarsDir) },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadAvatar = multer({ storage: avatarStorage });

// Genel dosyalar için multer yapılandırması
const fileStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, filesDir) },
    filename: function (req, file, cb) {
        // Orijinal dosya adını koruyarak benzersiz bir ön ek ekle
        const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniquePrefix + '-' + file.originalname);
    }
});
const uploadFile = multer({ storage: fileStorage });

// Yeni Avatar Yükleme Endpoint'i
app.post('/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenmedi.' });
    }
    // Render'da public URL'yi doğru oluşturmak için
    const host = req.get('host');
    const protocol = req.protocol;
    const avatarUrl = `${protocol}://${host}/uploads/avatars/${req.file.filename}`;
    res.json({ avatarUrl: avatarUrl });
});

// Genel Dosya Yükleme Endpoint'i
app.post('/upload-file', uploadFile.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Dosya yüklenmedi.' });
    }
    const host = req.get('host');
    const protocol = req.protocol;
    const fileUrl = `${protocol}://${host}/uploads/files/${req.file.filename}`;
    res.json({ 
        fileUrl: fileUrl,
        fileName: req.file.originalname, // Orijinal dosya adını geri gönder
        fileType: req.file.mimetype // Dosya türünü geri gönder
    });
});

// --- FIREBASE BAĞLANTISI (RENDER AYARI) ---
let db, auth;
try {
    let serviceAccount;
    // 1. Render Ortam Değişkeninden okumayı dene (deployment ortamı)
    if (process.env.SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    } else {
        // 2. Yerel dosyadan okumayı dene (yerel test ortamı)
        serviceAccount = require('./serviceAccountKey.json');
    }
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    auth = admin.auth();
    console.log('[SUNUCU] Firebase Admin SDK başarıyla başlatıldı.');

} catch (error) {
    console.error('*****************************************************');
    console.error('[HATA] Firebase başlatılamadı. ServiceAccount Anahtarı eksik/hatalı.');
    process.exit(1);
}

// --- YENİ: Dinamik Rol ve İzin Yönetimi ---
const ROLES = {
  Kurucu: { level: 3, canManage: ['Admin', 'Üye'] },
  Admin:   { level: 2, canManage: ['Üye'] },
  Üye:     { level: 1, canManage: [] }
};

/**
 * Bir kullanıcının başka bir kullanıcı üzerinde işlem yapma yetkisi olup olmadığını kontrol eder.
 * @param {string} requesterRole - İşlemi yapanın rolü.
 * @param {string} targetRole - İşlem yapılanın rolü.
 * @returns {boolean} Yetkisi varsa true döner.
 */
function hasPermission(requesterRole, targetRole) {
    const requesterLevel = ROLES[requesterRole]?.level || 0;
    const targetLevel = ROLES[targetRole]?.level || 0;
    // Bir kullanıcı, yalnızca kendinden daha düşük seviyedeki rollere sahip kullanıcılar üzerinde işlem yapabilir.
    return requesterLevel > targetLevel;
}

const md = markdownit(); // Markdown parser'ı başlat

// 💡 DEĞİŞİKLİK: Tek bir sohbet odası için sabit bir ID.
const TEAM_ID = 'main-team-room';

const onlineUsers = {};
const userStatus = {};      
const AVATAR_URLS = [ 'https://i.pravatar.cc/150?img=1', 'https://i.pravatar.cc/150?img=2', 'https://i.pravatar.cc/150?img=3', 'https://i.pravatar.cc/150?img=4', 'https://i.pravatar.cc/150?img=5' ];


async function getAllUsers() {
    const allUsersSnapshot = await db.collection('users').get();
    const allUsers = [];

    allUsersSnapshot.forEach(doc => {
        const userData = doc.data();
        const isOnline = Object.values(onlineUsers).some(onlineUser => onlineUser.uid === userData.uid);
        // 💡 DÜZELTME: Kullanıcı çevrimdışıysa socketId null olmalı.
        const socketId = isOnline ? Object.keys(onlineUsers).find(sid => onlineUsers[sid].uid === userData.uid) : null;

        allUsers.push({
            uid: userData.uid,
            nickname: userData.nickname,
            avatarUrl: userData.avatarUrl,
            banned: userData.banned || false, // 💡 YENİ: Yasaklanma durumunu ekle
            role: userData.role || 'Üye',
            isOnline: isOnline,
            createdAt: userData.createdAt ? userData.createdAt.toDate() : null, // 💡 YENİ: Katılma tarihini gönder
            status: isOnline ? (userStatus[socketId] || {}) : {},
        });
    });

    return allUsers.sort((a, b) => b.isOnline - a.isOnline || a.nickname.localeCompare(b.nickname));
}

io.on('connection', (socket) => {
    // 💡 DEĞİŞİKLİK: Her bağlanan kullanıcıyı ana odaya al.
    socket.join(TEAM_ID);
    console.log(`[SUNUCU] Bir kullanıcı bağlandı ve '${TEAM_ID}' odasına katıldı.`);
    
  // ------------------------------------
  // 0. KAYIT/GİRİŞ (FIREBASE KULLANILDI)
  // ------------------------------------
  
  socket.on('register', async ({ nickname, email, password }) => {
      try {
          const userRecord = await auth.createUser({
              email: email.toLowerCase(),
              password: password,
              displayName: nickname,
          });

          const randomAvatar = AVATAR_URLS[Math.floor(Math.random() * AVATAR_URLS.length)];
          
          const usersCollection = db.collection('users');
          const userCountSnapshot = await usersCollection.count().get();
          const userCount = userCountSnapshot.data().count;
          const userRole = userCount === 0 ? 'Kurucu' : 'Üye';

          // 💡 DEĞİŞİKLİK: 'servers' alanı kaldırıldı.
          await db.collection('users').doc(userRecord.uid).set({
              nickname,
              avatarUrl: randomAvatar,
              email: email.toLowerCase(),
              uid: userRecord.uid,
              role: userRole, // Rolü kaydet
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log(`[SUNUCU] Yeni kayıt (Firebase): ${nickname}`);
          socket.emit('auth success', { type: 'register' });

      } catch (err) {
          console.error('Kayıt hatası:', err.message);
          let errorMessage = 'Kayıt sırasında bilinmeyen bir hata oluştu.';
          if (err.code === 'auth/email-already-in-use') { errorMessage = 'Bu e-posta adresi zaten kullanılıyor.'; }
          socket.emit('auth error', errorMessage);
      }
  });

  socket.on('login', async ({ email, password, rememberMe }) => {
      try {
        // 💡 DÜZELTME: Firebase Auth ile şifre doğrulaması yapılıyor.
        // Bu, doğrudan veritabanı sorgusu yapmaktan çok daha güvenlidir.
        // Not: Bu yöntemin çalışması için Firebase projenizde "Authentication" > "Sign-in method" > "Email/Password" aktif olmalıdır.
        const userRecord = await auth.getUserByEmail(email.toLowerCase());
        const uid = userRecord.uid;

        // Şifre kontrolü için Firebase Auth REST API'sini kullanıyoruz.
        // Bu, Admin SDK'nın doğrudan şifre doğrulama yeteneği olmadığı için bir çözümdür.
        // Bu API anahtarını Firebase projenizin ayarlarından alabilirsiniz.
        // ÖNEMLİ: Bu anahtarı normalde bir ortam değişkeninde saklamak daha güvenlidir.
        const apiKey = process.env.FIREBASE_WEB_API_KEY;
        if (!apiKey) throw new Error('Firebase Web API Anahtarı ayarlanmamış. (.env dosyasını kontrol edin)');

        const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, { // 'fetch' is globally available in recent Node.js versions
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true })
        });

        if (!response.ok) {
            throw new Error('E-posta veya şifre hatalı.');
        }

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) throw new Error('Kullanıcı veritabanında bulunamadı.');
        const userData = userDoc.data();

        // 💡 YENİ: Kullanıcı yasaklı mı diye kontrol et.
        if (userData.banned) {
            socket.emit('auth error', 'Bu hesaba erişim engellenmiştir.');
            return;
        }

        // 💡 DEĞİŞİKLİK: Kullanıcıyı ana odaya bağla.
        onlineUsers[socket.id] = { nickname: userData.nickname, avatarUrl: userData.avatarUrl, email: userData.email, socketId: socket.id, uid: uid, role: userData.role || 'Üye' };
        userStatus[socket.id] = { presence: 'online', muted: false, deafened: false, speaking: false, channel: null };
        
        // 💡 DEĞİŞİKLİK: Giriş başarılı yanıtı basitleştirildi. Sunucu listesi yok.
        socket.emit('login success', { nickname: userData.nickname, avatarUrl: userData.avatarUrl, uid: uid, role: userData.role || 'Üye' });
        console.log(`[SUNUCU] Giriş başarılı: ${userData.nickname}`);

      } catch (err) {
          // Firebase kimlik doğrulama hatası (örneğin, yanlış şifre)
          console.error('Giriş hatası:', err.code, err.message);
          socket.emit('auth error', 'E-posta veya şifre hatalı.');
      }
  });

    // 💡 DEĞİŞİKLİK: Bu olay artık istemci tarafından çağrılmıyor, girişten hemen sonra tetikleniyor.
    socket.on('request initial data', async () => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        // Kanalları ve kullanıcı listesini gönder
        await Promise.all([
            sendChannelList(socket),
            getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users)),
            sendDmHistory(socket, user.uid) // 💡 YENİ: DM geçmişini gönder
        ]);
        socket.emit('initial data loaded'); // Arayüzün gösterilmesini tetikle
    });

  // ------------------------------------
  // PROFİL GÜNCELLEME
  // ------------------------------------
  socket.on('update profile', async ({ newNickname, newAvatarUrl }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    try {
        const userRef = db.collection('users').doc(user.uid);
        const userDoc = await userRef.get();
        const currentData = userDoc.data();
        
        const updateData = {
            nickname: newNickname || currentData.nickname, 
            avatarUrl: newAvatarUrl || currentData.avatarUrl,
            // Rol güncelleme mantığı buraya eklenebilir (örn: sadece adminler için)
        };
        await userRef.update(updateData);

        user.nickname = updateData.nickname;
        user.avatarUrl = updateData.avatarUrl;
        
        // Firebase Auth tarafını da güncelle
        await auth.updateUser(user.uid, { displayName: updateData.nickname, photoURL: updateData.avatarUrl });
        
        socket.emit('profile update success', { nickname: user.nickname, avatarUrl: user.avatarUrl, role: user.role });
        // Profil güncellendiğinde tüm kullanıcılara listeyi tekrar gönder
        getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));

    } catch(err) {
        console.error('Profil güncelleme hatası:', err.message);
        socket.emit('profile update error', 'Profil güncellenirken bir hata oluştu.');
    }
  });

  // 💡 YENİ: Kullanıcı durumu güncelleme
  socket.on('set status', (newStatus) => {
    const user = onlineUsers[socket.id];
    if (!user || !userStatus[socket.id]) return;

    // 'online', 'idle', 'dnd', 'invisible' gibi geçerli durumları kontrol et
    const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
    if (validStatuses.includes(newStatus)) {
        userStatus[socket.id].presence = newStatus;
        getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
    }
  });

  // --- YÖNETİCİ İŞLEMLERİ ---

  socket.on('admin:change-role', async ({ targetUid, newRole }) => {
    const requester = onlineUsers[socket.id];
    if (!ROLES[newRole]) {
      return socket.emit('system error', 'Geçersiz rol ataması.');
    }

    try {
      const targetUserRef = db.collection('users').doc(targetUid);
      const targetUserDoc = await targetUserRef.get();

      if (!targetUserDoc.exists) return;

      const targetRole = targetUserDoc.data().role || 'Üye';

      // Yeni izin kontrolü: İstek yapanın rolü, hedef kullanıcının rolünden üstün mü?
      if (!requester || !hasPermission(requester.role, targetRole)) {
        return socket.emit('system error', 'Bu kullanıcı üzerinde işlem yapma yetkiniz yok.');
      }

      // Yeni rol, istek yapanın rolünden daha yüksek olamaz.
      if (ROLES[newRole].level >= ROLES[requester.role].level) {
        return socket.emit('system error', 'Kendinizden daha yüksek bir rol atayamazsınız.');
      }

      await targetUserRef.update({ role: newRole });
      // Tüm kullanıcılara güncel listeyi gönder
      getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
    } catch (error) {
      console.error('Rol değiştirme hatası:', error);
    }
  });

  socket.on('admin:kick', async ({ targetUid }) => {
    const requester = onlineUsers[socket.id];
    const targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].uid === targetUid);
    const targetUser = onlineUsers[targetSocketId];

    if (!requester || !targetUser || !hasPermission(requester.role, targetUser.role)) {
        return socket.emit('system error', 'Bu kullanıcıyı atma yetkiniz yok.');
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
        targetSocket.emit('kicked', { reason: `Sunucudan ${requester.nickname} tarafından atıldınız.` });
        targetSocket.disconnect(true);
    }
  });

  socket.on('admin:toggle-ban', async ({ targetUid }) => {
      const requester = onlineUsers[socket.id];
      if (!requester || !['Kurucu', 'Admin'].includes(requester.role)) {
          return socket.emit('system error', 'Bu işlemi yapma yetkiniz yok.');
      }
      try {
          const userRef = db.collection('users').doc(targetUid);
          const userDoc = await userRef.get();
          if (!userDoc.exists) return;

          const isBanned = userDoc.data().banned || false;
          await userRef.update({ banned: !isBanned });

          getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
      } catch (error) {
          console.error('Yasaklama hatası:', error);
      }
  });

  // Diğer tüm olay dinleyicileri (mesajlaşma, kanal yönetimi vb.) buraya gelecek...
  // Örnek:
  socket.on('chat message', async (data) => { // 💡 YENİ: Gelişmiş DM mantığı
    const user = onlineUsers[socket.id];
    if (!user) return;

    const sanitizedMessage = data.type === 'file' ? data.message : md.renderInline(data.message);

    const messageData = {
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        message: sanitizedMessage,
        channel: data.channelId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        senderUid: user.uid,
        type: data.type || 'text',
        fileUrl: data.fileUrl || null,
        fileType: data.fileType || null,
        reactions: {},
        replyTo: data.replyTo || null,
        edited: false
    };

    const docRef = await db.collection('messages').add(messageData);
    const finalMessage = { ...messageData, timestamp: new Date(), id: docRef.id };

    if (data.channelId.startsWith('dm_')) {
        // Bu bir özel mesaj (DM)
        const uids = data.channelId.replace('dm_', '').split('_');
        const recipientUid = uids.find(uid => uid !== user.uid);

        // 💡 YENİ: `conversations` koleksiyonunu güncelle
        const conversationRef = db.collection('conversations').doc(data.channelId);
        await conversationRef.set({
            participants: uids, // Sıralı UID'ler
            lastMessage: data.type === 'file' ? `Dosya: ${data.message}` : data.message,
            lastMessageTimestamp: messageData.timestamp,
            lastSenderUid: user.uid
        }, { merge: true });

        const recipientSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].uid === recipientUid);

        // Mesajı gönderene ve alıcıya gönder
        socket.emit('chat message', finalMessage);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('chat message', finalMessage);
        }
    } else {
        // Bu bir genel kanal mesajı
        io.to(TEAM_ID).emit('chat message', finalMessage);
    }
  });

  socket.on('message reaction', async ({ messageId, emoji }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    const messageRef = db.collection('messages').doc(messageId);
    try {
      await db.runTransaction(async (transaction) => {
        const messageDoc = await transaction.get(messageRef);
        if (!messageDoc.exists) return;
        const data = messageDoc.data();
        const reactions = data.reactions || {};
        if (!reactions[emoji]) reactions[emoji] = [];
        const userIndex = reactions[emoji].indexOf(user.uid);
        if (userIndex > -1) {
          reactions[emoji].splice(userIndex, 1);
          if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
          reactions[emoji].push(user.uid);
        }
        transaction.update(messageRef, { reactions });
        io.to(TEAM_ID).emit('reaction update', { messageId, reactions });
      });
    } catch (error) { console.error('Tepki işlenirken hata:', error); }
  });

  socket.on('delete message', async (messageId) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    const messageRef = db.collection('messages').doc(messageId);
    try {
      const doc = await messageRef.get();
      if (doc.exists && doc.data().senderUid === user.uid) {
        await messageRef.delete();
        io.to(TEAM_ID).emit('message deleted', { messageId });
      }
    } catch (error) { console.error('Mesaj silinirken hata:', error); }
  });

  socket.on('edit message', async ({ messageId, newMessage }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    const messageRef = db.collection('messages').doc(messageId);
    try {
      const doc = await messageRef.get();
      if (doc.exists && doc.data().senderUid === user.uid) {
        const sanitizedMessage = md.renderInline(newMessage);
        await messageRef.update({ message: sanitizedMessage, edited: true });
        io.to(TEAM_ID).emit('message edited', { messageId, newMessage: sanitizedMessage });
      }
    } catch (error) { console.error('Mesaj düzenlenirken hata:', error); }
  });

  socket.on('create-channel', async ({ name, type }) => {
    try {
      const docRef = await db.collection('channels').add({ name, type });
      io.to(TEAM_ID).emit('channel-created', { id: docRef.id, name, type });
    } catch (error) { console.error('Kanal oluşturma hatası:', error); }
  });

  socket.on('delete-channel', async (channelId) => {
    try {
      await db.collection('channels').doc(channelId).delete();
      io.to(TEAM_ID).emit('channel-deleted', channelId);
    } catch (error) { console.error('Kanal silme hatası:', error); }
  });

  socket.on('request past messages', (channelId) => {
      sendPastMessages(socket, channelId);
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) {
        delete onlineUsers[socket.id];
        delete userStatus[socket.id];
        io.to(TEAM_ID).emit('system message', { message: `${user.nickname} sohbetten ayrıldı.` });
        getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
    }
    console.log(`[SUNUCU] Kullanıcı bağlantısı kesildi: ${socket.id}`);
  });

// Tüm kanalları veritabanından çekip gönderen fonksiyon
async function sendChannelList(socket) {
    try {
        const channelsSnapshot = await db.collection('channels').get();
        const channels = [];
        channelsSnapshot.forEach(doc => {
            channels.push({ id: doc.id, ...doc.data() });
        });
        socket.emit('channel-list', channels);
    } catch (error) {
        console.error('Kanal listesi çekerken hata:', error);
    }
}

// Geçmiş mesajları belirli bir kanaldan çekip gönderen fonksiyon
async function sendPastMessages(socket, channelId) {
    try {
        const messagesRef = db.collection('messages')
                                .where('channel', '==', channelId)
                                .orderBy('timestamp', 'desc')
                                .limit(50); // Son 50 mesajı çek
        const snapshot = await messagesRef.get();
        const pastMessages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            pastMessages.unshift({ ...data, timestamp: data.timestamp.toDate() }); // En eski mesaj en üstte olacak şekilde sırala
        });
        socket.emit('past messages', { channelId, messages: pastMessages });
    } catch (error) {
        console.error('Geçmiş mesajları çekerken hata:', error);
    }
}

// 💡 YENİ: Kullanıcının dahil olduğu tüm DM kanallarını ve son mesajları getiren fonksiyon
async function sendDmHistory(socket, userId) {
  try {
    const conversationsSnapshot = await db.collection('conversations')
      .where('participants', 'array-contains', userId)
      .orderBy('lastMessageTimestamp', 'desc')
      .get();

    if (conversationsSnapshot.empty) {
      socket.emit('dm history', []);
      return;
    }

    const dmHistory = [];
    conversationsSnapshot.forEach(doc => {
      const data = doc.data();
      dmHistory.push({
        id: doc.id,
        ...data,
        lastMessageTimestamp: data.lastMessageTimestamp.toDate() // İstemci için tarihi dönüştür
      });
    });
    socket.emit('dm history', dmHistory);
  } catch (error) {
    console.error('DM geçmişi çekerken hata:', error);
  }
}

});

// RENDER İÇİN PORT AYARI
const RENDER_PORT = process.env.PORT || PORT;
server.listen(RENDER_PORT, () => {
  console.log(`[SUNUCU BAŞARILI] AuraChat port ${RENDER_PORT}'da çalışıyor.`);
  // 💡 YENİ: Sunucunun hazır olduğunu ana sürece (main.js) bildir.
  if (process.send) {
    process.send('server-ready');
  }
});
