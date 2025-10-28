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
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = 3000;
const DEFAULT_CHANNEL_NAME = 'genel';

// Dosya yükleme dizinleri
const uploadsDir = path.join(__dirname, 'uploads');
const avatarsDir = path.join(uploadsDir, 'avatars');
const filesDir = path.join(uploadsDir, 'files'); // 💡 YENİ: Genel dosyalar için yeni klasör

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir);
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir); // 💡 YENİ: Klasörü oluştur

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const avatarStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, avatarsDir) },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadAvatar = multer({ storage: avatarStorage });

// 💡 YENİ: Genel dosyalar için yeni multer yapılandırması
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

// 💡 YENİ: Genel Dosya Yükleme Endpoint'i
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

const md = markdownit(); // Markdown parser'ı başlat

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
            status: isOnline ? (userStatus[socketId] || {}) : {}
        });
    });

    return allUsers.sort((a, b) => b.isOnline - a.isOnline || a.nickname.localeCompare(b.nickname));
}

io.on('connection', (socket) => {
    
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

          // 💡 YENİ: Kullanıcının ait olduğu sunucuları takip etmek için boş bir dizi ekle.
          await db.collection('users').doc(userRecord.uid).set({
              nickname,
              avatarUrl: randomAvatar,
              email: email.toLowerCase(),
              uid: userRecord.uid,
              role: userRole // Rolü kaydet
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
        const apiKey = process.env.FIREBASE_WEB_API_KEY; // Bu ortam değişkenini ayarlamanız gerekecek.
        if (!apiKey) throw new Error('Firebase Web API Anahtarı ayarlanmamış.');

        const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
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

        onlineUsers[socket.id] = { nickname: userData.nickname, avatarUrl: userData.avatarUrl, email: userData.email, socketId: socket.id, uid: uid, role: userData.role || 'Üye' };
        userStatus[socket.id] = { presence: 'online', muted: false, deafened: false, speaking: false, channel: null };
        
        // 💡 YENİ: Kullanıcının ait olduğu sunucuları getir.
        const userServers = await getUserServers(uid);

        socket.emit('login success', { nickname: userData.nickname, avatarUrl: userData.avatarUrl, uid: uid, role: userData.role || 'Üye', servers: userServers });
        console.log(`[SUNUCU] Giriş başarılı: ${userData.nickname}`);

      } catch (err) {
          // Firebase kimlik doğrulama hatası (örneğin, yanlış şifre)
          console.error('Giriş hatası:', err.code, err.message);
          socket.emit('auth error', 'E-posta veya şifre hatalı.');
      }
  });

    // 💡 YENİ: Sunucu oluşturma
    socket.on('create_server', async (serverName) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        try {
            const inviteCode = generateInviteCode();
            const serverRef = db.collection('servers').doc();
            const serverId = serverRef.id;

            // Varsayılan kanalları oluştur
            const textChannelRef = db.collection('channels').doc();
            const voiceChannelRef = db.collection('channels').doc();

            const batch = db.batch();
            batch.set(serverRef, {
                name: serverName,
                ownerId: user.uid,
                inviteCode: inviteCode,
                members: [user.uid] // Kurucu üyeyi ekle
            });
            batch.set(textChannelRef, { name: DEFAULT_CHANNEL_NAME, type: 'text', serverId: serverId });
            batch.set(voiceChannelRef, { name: 'Sohbet Odası', type: 'voice', serverId: serverId });
            
            // Kullanıcının sunucu listesini güncelle
            const userRef = db.collection('users').doc(user.uid);
            batch.update(userRef, { servers: admin.firestore.FieldValue.arrayUnion(serverId) });

            await batch.commit();

            const newServerData = { id: serverId, name: serverName, icon: null }; // icon gelecekte eklenebilir
            socket.emit('server_created', newServerData);
            console.log(`[SUNUCU] ${user.nickname} yeni bir sunucu oluşturdu: ${serverName}`);
        } catch (error) {
            console.error("Sunucu oluşturma hatası:", error);
            socket.emit('system error', 'Sunucu oluşturulurken bir hata oluştu.');
        }
    });

    // 💡 YENİ: Davet koduyla sunucuya katılma
    socket.on('join_server_with_code', async (inviteCode) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        try {
            const serversQuery = await db.collection('servers').where('inviteCode', '==', inviteCode).limit(1).get();
            if (serversQuery.empty) {
                return socket.emit('system error', 'Geçersiz davet kodu.');
            }

            const serverDoc = serversQuery.docs[0];
            const serverId = serverDoc.id;
            const serverData = serverDoc.data();

            if (serverData.members && serverData.members.includes(user.uid)) {
                return socket.emit('system error', 'Bu sunucuya zaten üyesiniz.');
            }

            const batch = db.batch();
            batch.update(serverDoc.ref, { members: admin.firestore.FieldValue.arrayUnion(user.uid) });
            batch.update(db.collection('users').doc(user.uid), { servers: admin.firestore.FieldValue.arrayUnion(serverId) });
            await batch.commit();

            const joinedServerData = { id: serverId, name: serverData.name, icon: null };
            socket.emit('server_joined', joinedServerData);
            io.to(serverId).emit('system message', { message: `${user.nickname} sunucuya katıldı.` });
            console.log(`[SUNUCU] ${user.nickname} bir sunucuya katıldı: ${serverData.name}`);
        } catch (error) {
            console.error("Sunucuya katılma hatası:", error);
            socket.emit('system error', 'Sunucuya katılırken bir hata oluştu.');
        }
    });

    // 💡 YENİ: Bir sunucuya giriş yapma ve verilerini isteme
    socket.on('join_server', async (serverId) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        // Önceki sunucu odasından ayrıl
        if (socket.currentServerId) {
            socket.leave(socket.currentServerId);
        }

        socket.join(serverId);
        socket.currentServerId = serverId;
        console.log(`[SUNUCU] ${user.nickname}, ${serverId} sunucusuna giriş yaptı.`);

        // Sunucuya ait kanalları ve geçmiş mesajları gönder
        await Promise.all([
            sendChannelList(socket, serverId),
            getAllUsers().then(users => io.to(serverId).emit('user list', users)) // Sunucudaki herkese kullanıcı listesini gönder
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
        if (socket.currentServerId) getAllUsers().then(users => io.to(socket.currentServerId).emit('user list', users));

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
        if (socket.currentServerId) getAllUsers().then(users => io.to(socket.currentServerId).emit('user list', users));
    }
  });

  // 💡 YENİ: Yönetici rol değiştirme
  socket.on('admin:change-role', async ({ targetUid, newRole }) => {
    const requester = onlineUsers[socket.id];
    if (!requester || !['Kurucu', 'Admin'].includes(requester.role)) {
      socket.emit('system error', 'Bu işlemi yapma yetkiniz yok.');
      return;
    }

    const validRoles = ['Admin', 'Üye']; // Değiştirilebilecek roller
    if (!validRoles.includes(newRole)) {
      socket.emit('system error', 'Geçersiz rol ataması.');
      return;
    }

    try {
      const targetUserRef = db.collection('users').doc(targetUid);
      const targetUserDoc = await targetUserRef.get();

      if (!targetUserDoc.exists) return;

      // Kurucunun rolü değiştirilemez.
      if (targetUserDoc.data().role === 'Kurucu') {
        socket.emit('system error', 'Kurucunun rolü değiştirilemez.');
        return;
      }

      await targetUserRef.update({ role: newRole });
      getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
    } catch (error) {
      console.error('Rol değiştirme hatası:', error);
    }
  });

  // 💡 YENİ: Mesaj tepkisi ekleme/kaldırma
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
        
        if (!reactions[emoji]) {
          reactions[emoji] = [];
        }

        const userIndex = reactions[emoji].indexOf(user.uid);
        if (userIndex > -1) {
          // Kullanıcı zaten bu emoji ile tepki vermiş, tepkisini kaldır
          reactions[emoji].splice(userIndex, 1);
          if (reactions[emoji].length === 0) {
            delete reactions[emoji];
          }
        } else {
          // Kullanıcı yeni tepki veriyor
          reactions[emoji].push(user.uid);
        }
        transaction.update(messageRef, { reactions });
        if (socket.currentServerId) io.to(socket.currentServerId).emit('reaction update', { messageId, reactions });
      });
    } catch (error) {
      console.error('Tepki işlenirken hata:', error);
    }
  });

  // 💡 YENİ: Mesaj silme
  socket.on('delete message', async (messageId) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    const messageRef = db.collection('messages').doc(messageId);
    try {
      const doc = await messageRef.get();
      if (doc.exists && doc.data().senderUid === user.uid) {
        await messageRef.delete();
        if (socket.currentServerId) io.to(socket.currentServerId).emit('message deleted', { messageId });
      } else {
        // Yetkisiz silme denemesi
        socket.emit('system error', 'Bu mesajı silme yetkiniz yok.');
      }
    } catch (error) {
      console.error('Mesaj silinirken hata:', error);
    }
  });

  // 💡 YENİ: Mesaj düzenleme
  socket.on('edit message', async ({ messageId, newMessage }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    const messageRef = db.collection('messages').doc(messageId);
    try {
      const doc = await messageRef.get();
      if (doc.exists && doc.data().senderUid === user.uid) {
        const sanitizedMessage = md.renderInline(newMessage);
        await messageRef.update({ message: sanitizedMessage, edited: true });
        if (socket.currentServerId) io.to(socket.currentServerId).emit('message edited', { messageId, newMessage: sanitizedMessage });
      }
    } catch (error) {
      console.error('Mesaj düzenlenirken hata:', error);
    }
  });

  // ------------------------------------
  // KANAL YÖNETİMİ
  // ------------------------------------
  socket.on('create-channel', async ({ name, type }) => {
    if (!name || (type !== 'text' && type !== 'voice')) {
      // Geçersiz istek, belki bir hata mesajı gönderilebilir.
      return;
    }
    // 💡 YENİ: Kanal oluştururken sunucu ID'sini de kaydet.
    try {
      const docRef = await db.collection('channels').add({ name, type, serverId: socket.currentServerId });
      const newChannel = { id: docRef.id, name, type };
      io.to(socket.currentServerId).emit('channel-created', newChannel);
    } catch (error) {
      console.error('Kanal oluşturma hatası:', error);
    }
  });

  socket.on('delete-channel', async (channelId) => {
    try {
      await db.collection('channels').doc(channelId).delete();
      io.to(socket.currentServerId).emit('channel-deleted', channelId);
    } catch (error) {
      console.error('Kanal silme hatası:', error);
    }
  });


  // ------------------------------------
  // CHAT, SES ve DİĞER FONKSİYONLAR
  // ------------------------------------
  
  socket.on('chat message', async (data) => {
      const user = onlineUsers[socket.id];
      if (!user) return;

      let messageData;

      if (data.type === 'file') {
          // Bu bir dosya mesajı
          messageData = { 
              nickname: user.nickname, avatarUrl: user.avatarUrl, 
              message: data.fileName, // Mesaj içeriği olarak dosya adı
              fileUrl: data.fileUrl,
              fileType: data.fileType,
              type: 'file', // Mesaj türünü belirt
              channel: data.channelId, 
              timestamp: admin.firestore.FieldValue.serverTimestamp(), 
              senderUid: user.uid, 
              reactions: {},
              replyTo: data.replyTo || null,
              edited: false
          };
      } else {
          // Bu bir metin mesajı
          const sanitizedMessage = md.renderInline(data.message);

          // 💡 YENİ: @bahsetme (mention) işleme
          const allUsernames = Object.values(onlineUsers).map(u => u.nickname);
          // Regex ile @kullaniciadi formatını bul ve değiştir
          const mentionedMessage = sanitizedMessage.replace(/@(\w+)/g, (match, username) => {
              // Kullanıcı adının tam olarak eşleşip eşleşmediğini kontrol et (büyük/küçük harf duyarsız)
              const foundUser = Object.values(onlineUsers).find(u => u.nickname.toLowerCase() === username.toLowerCase());
              if (foundUser) {
                  return `<span class="mention" data-uid="${foundUser.uid}">@${foundUser.nickname}</span>`;
              }
              return match; // Eşleşme bulunamazsa orijinal metni koru
          });

          messageData = {
              nickname: user.nickname, 
              avatarUrl: user.avatarUrl, 
              message: mentionedMessage, // İşlenmiş mesajı kaydet
              channel: data.channelId, 
              timestamp: admin.firestore.FieldValue.serverTimestamp(), 
              senderUid: user.uid, type: 'text', 
              reactions: {},
              replyTo: data.replyTo || null,
              edited: false
          };
      }

      const docRef = await db.collection('messages').add(messageData); // Önce veritabanına ekle

      const finalMessage = { ...messageData, timestamp: new Date(), id: docRef.id };

      if (data.channelId.startsWith('dm_')) {
          // Bu bir özel mesaj (DM)
          const uids = data.channelId.replace('dm_', '').split('_');
          const recipientUid = uids.find(uid => uid !== user.uid);

          const recipientSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].uid === recipientUid);

          socket.emit('chat message', finalMessage); // Mesajı gönderene geri gönder
          if (recipientSocketId) {
              io.to(recipientSocketId).emit('chat message', finalMessage); // Mesajı alıcıya gönder
          }
      } else {
          // Bu bir genel kanal mesajı
          io.to(socket.currentServerId).emit('chat message', finalMessage);
      }
  });

  socket.on('join voice channel', (channelId) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    userStatus[socket.id].channel = channelId;
    const voiceRoomId = `${socket.currentServerId}-${channelId}`;
    socket.join(voiceRoomId);
    socket.to(voiceRoomId).emit('user joined', socket.id);
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) ses kanalına katıldı: ${channelId}`);

    // Kanaldaki diğer kullanıcıları yeni katılan kullanıcıya gönder
    const usersInChannel = Object.values(onlineUsers).filter(u => userStatus[u.socketId]?.channel === channelId && u.socketId !== socket.id);
    socket.emit('ready to talk', usersInChannel.map(u => u.socketId)); 

    getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users)); // Kullanıcı listesini güncelle
  });

  socket.on('leave voice channel', (channelId) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    userStatus[socket.id].channel = null;
    userStatus[socket.id].speaking = false; // Kanaldan ayrılınca konuşma durumunu sıfırla
    const voiceRoomId = `${socket.currentServerId}-${channelId}`;
    socket.leave(voiceRoomId);
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) ses kanalından ayrıldı: ${channelId}`);
    socket.to(voiceRoomId).emit('user left', socket.id);

    if (socket.currentServerId) getAllUsers().then(users => io.to(socket.currentServerId).emit('user list', users));
  });

  socket.on('toggle status', (data) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) durumu değişti: ${data.status} = ${data.value}`);
    userStatus[socket.id][data.status] = data.value;
    if (socket.currentServerId) getAllUsers().then(users => io.to(socket.currentServerId).emit('user list', users));
  });

  socket.on('toggle speaking', (isSpeaking) => { 
    const user = onlineUsers[socket.id];
    if (!user) return;
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) konuşma durumu: ${isSpeaking}`);
    userStatus[socket.id].speaking = isSpeaking;
    if (socket.currentServerId) getAllUsers().then(users => io.to(socket.currentServerId).emit('user list', users));
  });
  
  socket.on('typing', (isTyping) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    // 💡 DÜZELTME: Sadece mevcut sunucudaki diğer kullanıcılara gönder
    if (socket.currentServerId) socket.to(socket.currentServerId).emit('typing', { nickname: user.nickname, isTyping });
  });

  // WebRTC Sinyalleşmesi
  socket.on('offer', (id, message) => { console.log(`[SUNUCU] Offer gönderiliyor to ${id} from ${socket.id}`); socket.to(id).emit('offer', socket.id, message); });
  socket.on('answer', (id, message) => { console.log(`[SUNUCU] Answer gönderiliyor to ${id} from ${socket.id}`); socket.to(id).emit('answer', socket.id, message); });
  socket.on('candidate', (id, message) => { console.log(`[SUNUCU] ICE Candidate gönderiliyor to ${id} from ${socket.id}`); socket.to(id).emit('candidate', socket.id, message); });
  
  socket.on('logout', () => {
    console.log(`[SUNUCU] Kullanıcı çıkış yaptı: ${socket.id}`);
    // Logout olayında disconnect ile aynı işlemleri yap
    handleDisconnect(socket.id);
  });

  socket.on('request past messages', (channelId) => {
      sendPastMessages(socket, channelId);
  });

  // Kullanıcı bağlantıyı kestiğinde
  socket.on('disconnect', () => {
    handleDisconnect(socket.id);
  });

  function handleDisconnect(socketId) {
    console.log(`[SUNUCU] Kullanıcı bağlantısı kesildi: ${socketId}`);
    const user = onlineUsers[socketId];
    if (user) {
      io.to(socket.currentServerId).emit('system message', { message: `${user.nickname} sohbetten ayrıldı.` });
      if (userStatus[socketId]?.channel) { io.to(`${socket.currentServerId}-${userStatus[socketId].channel}`).emit('user left', socketId); }
      delete onlineUsers[socketId];
      delete userStatus[socketId];
      if (socket.currentServerId) getAllUsers().then(users => io.to(socket.currentServerId).emit('user list', users));
    }
  }
});

// RENDER İÇİN PORT AYARI
const RENDER_PORT = process.env.PORT || PORT;
server.listen(RENDER_PORT, () => {
  console.log(`[SUNUCU BAŞARILI] AuraChat port ${RENDER_PORT}'da çalışıyor.`);
});

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

// Tüm kanalları veritabanından çekip gönderen fonksiyon
async function sendChannelList(socket, serverId) {
    try {
        const channelsSnapshot = await db.collection('channels').where('serverId', '==', serverId).get();
        const channels = [];
        channelsSnapshot.forEach(doc => {
            channels.push({ id: doc.id, ...doc.data() });
        });
        socket.emit('channel-list', channels);
    } catch (error) {
        console.error('Kanal listesi çekerken hata:', error);
    }
}

// Kullanıcının dahil olduğu tüm DM kanallarını ve son mesajları getiren fonksiyon
async function sendDmHistory(socket, userId) {
  try {
    const messagesRef = db.collection('messages');
    // Firestore'da 'array-contains' sorgusu ile kullanıcının dahil olduğu DM kanallarını bulmak daha verimli olur.
    // Bunun için mesaj dökümanlarında 'participants' [uid1, uid2] gibi bir alan tutmak gerekir.
    // Mevcut yapıyla devam etmek için, tüm DM'leri çekip filtrelemek yerine, iki ayrı sorgu yapalım.
    const sentDmsQuery = messagesRef.where('senderUid', '==', userId).where('channel', '>=', 'dm_').get();
    // Alınan mesajları bulmak için 'participants' alanı olmadan verimli bir sorgu zordur.
    // Bu yüzden tüm DM'leri çekip filtrelemek şimdilik en basit çözüm.
    const allDmsSnapshot = await messagesRef.where('channel', '>=', 'dm_').where('channel', '<', 'dm`').get();

    const dmChannels = new Set(); // Tekrar eden kanalları önlemek için Set kullanalım.

    allDmsSnapshot.forEach(doc => {
      const data = doc.data();
      const uids = data.channel.replace('dm_', '').split('_');
      if (uids.includes(userId)) {
        dmChannels.add(data.channel);
      }
    });

    socket.emit('dm history', Array.from(dmChannels));
  } catch (error) {
    console.error('DM geçmişi çekerken hata:', error);
  }
}

// 💡 YENİ: Kullanıcının üye olduğu sunucuları getiren fonksiyon
async function getUserServers(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || !userDoc.data().servers) {
            return [];
        }
        const serverIds = userDoc.data().servers;
        if (serverIds.length === 0) return [];

        const serversQuery = await db.collection('servers').where(admin.firestore.FieldPath.documentId(), 'in', serverIds).get();
        const servers = [];
        serversQuery.forEach(doc => {
            servers.push({ id: doc.id, name: doc.data().name, icon: null }); // icon gelecekte eklenebilir
        });
        return servers;
    } catch (error) {
        console.error("Kullanıcı sunucuları çekilirken hata:", error);
        return [];
    }
}

// 💡 YENİ: Benzersiz davet kodu üreten fonksiyon
const generateInviteCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
