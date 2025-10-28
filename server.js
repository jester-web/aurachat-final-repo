const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path'); 
const multer = require('multer');
const crypto = require('crypto'); // 💡 YENİ: Güvenli token oluşturmak için
const markdownit = require('markdown-it'); // Markdown kütüphanesini dahil et

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = 3000;
const TEAM_ID = 'tek_ekip_sunucusu';
const MAIN_CHANNEL = 'ana-sohbet-kanali'; 
const VOICE_CHANNEL_ID = 'ana-ses-odasi'; 

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

// 💡 YENİ: Sunucu başlangıcında varsayılan kanalların varlığını kontrol et
async function ensureDefaultChannels() {
    const textChannelRef = db.collection('channels').doc(MAIN_CHANNEL);
    const voiceChannelRef = db.collection('channels').doc(VOICE_CHANNEL_ID);

    const textDoc = await textChannelRef.get();
    if (!textDoc.exists) {
        console.log(`[SUNUCU] Varsayılan metin kanalı '${MAIN_CHANNEL}' bulunamadı, oluşturuluyor...`);
        await textChannelRef.set({ name: 'genel-sohbet', type: 'text' });
    }
    const voiceDoc = await voiceChannelRef.get();
    if (!voiceDoc.exists) {
        console.log(`[SUNUCU] Varsayılan ses kanalı '${VOICE_CHANNEL_ID}' bulunamadı, oluşturuluyor...`);
        await voiceChannelRef.set({ name: 'Sohbet Odası', type: 'voice' });
    }
}

// Sunucu başladığında bu fonksiyonu çağır
ensureDefaultChannels();

const md = markdownit(); // Markdown parser'ı başlat

const onlineUsers = {};
const userStatus = {};      
const AVATAR_URLS = [ 'https://i.pravatar.cc/150?img=1', 'https://i.pravatar.cc/150?img=2', 'https://i.pravatar.cc/150?img=3', 'https://i.pravatar.cc/150?img=4', 'https://i.pravatar.cc/150?img=5' ];

// 💡 YENİ: Otomatik giriş anahtarlarını saklamak için (bellekte)
const autoLoginTokens = new Map(); // Map<token, uid>

async function handleSuccessfulLogin(socket, uid, rememberMe = false) {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
        socket.emit('auth error', 'Kullanıcı veritabanında bulunamadı.');
        return;
    }
    const userData = userDoc.data();

    onlineUsers[socket.id] = { ...userData, socketId: socket.id };
    // 💡 DÜZELTME: Kullanıcı durumuna 'presence' (varlık) alanı eklendi.
    userStatus[socket.id] = { presence: 'online', muted: false, deafened: false, speaking: false, channel: null }; 

    socket.join(TEAM_ID);
    io.to(TEAM_ID).emit('system message', { message: `${userData.nickname} sohbete katıldı.` });

    let authToken = null;
    if (rememberMe) {
        authToken = crypto.randomBytes(32).toString('hex');
        autoLoginTokens.set(authToken, uid);
    }

    socket.emit('login success', { ...userData, authToken });
    console.log(`[SUNUCU] Giriş başarılı: ${userData.nickname}`);

    await Promise.all([ sendChannelList(socket), sendPastMessages(socket, MAIN_CHANNEL), sendDmHistory(socket, uid), getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users)) ]);
    socket.emit('initial data loaded');
}

async function getAllUsers() {
    const allUsersSnapshot = await db.collection('users').get();
    const allUsers = [];

    allUsersSnapshot.forEach(doc => {
        const userData = doc.data();
        const isOnline = Object.values(onlineUsers).some(onlineUser => onlineUser.uid === userData.uid);
        // 💡 DÜZELTME: Kullanıcının socketId'sini doğru şekilde bul.
        const socketId = isOnline ? Object.keys(onlineUsers).find(sid => onlineUsers[sid].uid === userData.uid) : null; 

        allUsers.push({
            uid: userData.uid,
            nickname: userData.nickname,
            avatarUrl: userData.avatarUrl,
            role: userData.role || 'member', // 💡 YENİ: Kullanıcının rolünü ekle (varsayılan 'member')
            status: isOnline ? (userStatus[socketId] || {}) : {}
        });
    });

    return allUsers.sort((a, b) => b.isOnline - a.isOnline || a.nickname.localeCompare(b.nickname));
}

io.on('connection', (socket) => {

  // 💡 YENİ: Otomatik Giriş (Middleware gibi çalışır)
  // Bağlantı anında istemciden gelen token'ı kontrol et
  (async () => {
      const token = socket.handshake.auth.token;
      if (token && autoLoginTokens.has(token)) {
          const uid = autoLoginTokens.get(token);
          console.log(`[SUNUCU] Otomatik giriş denemesi başarılı. UID: ${uid}`);
          
          // Eski token'ı silip yenisini oluşturarak güvenliği artır
          autoLoginTokens.delete(token);
          const newAuthToken = crypto.randomBytes(32).toString('hex');
          autoLoginTokens.set(newAuthToken, uid);
          
          // İstemciye yeni token'ı gönder
          socket.emit('token-refreshed', newAuthToken);

          // Normal giriş akışını devam ettir
          await handleSuccessfulLogin(socket, uid, true); // rememberMe: true
          return; // Token ile giriş yapıldıysa, diğer auth olaylarını bekleme
      }
  })();

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
          await db.collection('users').doc(userRecord.uid).set({
              nickname,
              avatarUrl: randomAvatar,
              email: email.toLowerCase(),
            uid: userRecord.uid,
            role: 'member' // 💡 YENİ: Kayıt olurken varsayılan rol ata
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
          const userQuery = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
          if (userQuery.empty) {
               socket.emit('auth error', 'E-posta veya şifre hatalı.');
               return;
          }
          const uid = userQuery.docs[0].id;
          
          // 💡 YENİ: Başarılı giriş mantığını merkezi fonksiyona taşı
          await handleSuccessfulLogin(socket, uid, rememberMe);
      } catch (err) {
          // Firebase kimlik doğrulama hatası (örneğin, yanlış şifre)
          console.error('Giriş hatası:', err.code, err.message);
          socket.emit('auth error', 'E-posta veya şifre hatalı.');
      }
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
            avatarUrl: newAvatarUrl || currentData.avatarUrl
        };
        await userRef.update(updateData);

        user.nickname = updateData.nickname;
        user.avatarUrl = updateData.avatarUrl;
        
        // Firebase Auth tarafını da güncelle
        await auth.updateUser(user.uid, { displayName: updateData.nickname, photoURL: updateData.avatarUrl });
        
        socket.emit('profile update success', { nickname: user.nickname, avatarUrl: user.avatarUrl });
        // Profil güncellendiğinde tüm kullanıcılara listeyi tekrar gönder
        getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));

    } catch(err) {
        console.error('Profil güncelleme hatası:', err.message);
        socket.emit('profile update error', 'Profil güncellenirken bir hata oluştu.');
    }
  });

  // 💡 YENİ: Kullanıcı durumu güncelleme
  socket.on('set status', (newStatus) => {
    if (!userStatus[socket.id]) return;

    // 'online', 'idle', 'dnd', 'invisible' gibi geçerli durumları kontrol et
    const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
    if (validStatuses.includes(newStatus)) {
        console.log(`[SUNUCU] Durum güncellendi: ${onlineUsers[socket.id]?.nickname} -> ${newStatus}`);
        userStatus[socket.id].presence = newStatus;
        // 💡 DÜZELTME: Durum değiştiğinde tüm kullanıcılara güncel listeyi gönder.
        getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
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
        io.to(TEAM_ID).emit('reaction update', { messageId, reactions });
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
        io.to(TEAM_ID).emit('message deleted', { messageId });
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
        io.to(TEAM_ID).emit('message edited', { messageId, newMessage: sanitizedMessage });
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
    try {
      const docRef = await db.collection('channels').add({ name, type });
      const newChannel = { id: docRef.id, name, type };
      io.to(TEAM_ID).emit('channel-created', newChannel);
    } catch (error) {
      console.error('Kanal oluşturma hatası:', error);
    }
  });

  socket.on('delete-channel', async (channelId) => {
    try {
      await db.collection('channels').doc(channelId).delete();
      io.to(TEAM_ID).emit('channel-deleted', channelId);
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

      // 💡 YENİ: DM kanalı için Firestore belgesinin varlığını kontrol et/oluştur
      if (data.channelId.startsWith('dm_')) {
          const uids = data.channelId.replace('dm_', '').split('_').sort(); // Tutarlı sıralama için
          const dmChannelDocId = `dm_${uids[0]}_${uids[1]}`;
          const dmChannelRef = db.collection('dm-channels').doc(dmChannelDocId);
          const dmChannelDoc = await dmChannelRef.get();
          if (!dmChannelDoc.exists) {
              await dmChannelRef.set({ participants: uids, createdAt: admin.firestore.FieldValue.serverTimestamp() });
          }
      }

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
          io.to(TEAM_ID).emit('chat message', finalMessage);
      }
  });

  socket.on('join voice channel', (channelId) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    userStatus[socket.id].channel = channelId;
    socket.join(channelId);
    socket.to(channelId).emit('user joined', socket.id);
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) ses kanalına katıldı: ${channelId}`);

    // Kanaldaki diğer kullanıcıları yeni katılan kullanıcıya gönder
    const usersInChannel = Object.values(onlineUsers).filter(u => userStatus[u.socketId] && userStatus[u.socketId].channel === channelId && u.socketId !== socket.id);
    socket.emit('ready to talk', usersInChannel.map(u => u.socketId));

    getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users)); // Kullanıcı listesini güncelle
  });

  socket.on('leave voice channel', (channelId) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    userStatus[socket.id].channel = null;
    userStatus[socket.id].speaking = false; // Kanaldan ayrılınca konuşma durumunu sıfırla
    socket.leave(channelId);
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) ses kanalından ayrıldı: ${channelId}`);
    socket.to(channelId).emit('user left', socket.id);

    getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users)); // Kullanıcı listesini güncelle
  });

  socket.on('toggle status', (data) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) durumu değişti: ${data.status} = ${data.value}`);
    userStatus[socket.id][data.status] = data.value;
    getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users)); // Kullanıcı listesini güncelle
  });

  socket.on('toggle speaking', (isSpeaking) => { 
    const user = onlineUsers[socket.id];
    if (!user) return;
    console.log(`[SUNUCU] ${user.nickname} (${socket.id}) konuşma durumu: ${isSpeaking}`);
    userStatus[socket.id].speaking = isSpeaking; 
    getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
  });
  
  socket.on('typing', (isTyping) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    // console.log(`[SUNUCU] ${user.nickname} (${socket.id}) yazıyor: ${isTyping}`);
    // Sadece mevcut sohbet kanalındaki diğer kullanıcılara gönder
    socket.to(TEAM_ID).emit('typing', { nickname: user.nickname, isTyping });
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
  
  socket.on('logout', () => {
    const user = onlineUsers[socket.id];
    if (user) {
        // Kullanıcının tüm token'larını sil
        for (const [token, uid] of autoLoginTokens.entries()) { if (uid === user.uid) { autoLoginTokens.delete(token); } }
    }
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
    if (!user) return;

    // 💡 YENİ: Kullanıcı ayrıldı mesajı gönder
    io.to(TEAM_ID).emit('system message', { message: `${user.nickname} sohbetten ayrıldı.` });
    
    // Eğer sesli kanaldaysa, kanaldan ayrıldığını bildir
    if (userStatus[socketId].channel) {
      io.to(userStatus[socketId].channel).emit('user left', socketId);
    }

    delete onlineUsers[socketId]; 
    delete userStatus[socketId]; 
    
    getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users));
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
        let messagesRef;
        if (channelId.startsWith('dm_')) {
            // 💡 DÜZELTME: DM kanalları için mesajlar alt koleksiyonda bulunur.
            messagesRef = db.collection('dm-channels').doc(channelId).collection('messages')
                                .orderBy('timestamp', 'desc')
                                .limit(50);
        } else {
            // Genel kanallar için mesajlar ana 'messages' koleksiyonunda bulunur.
            messagesRef = db.collection('messages')
                                .where('channel', '==', channelId)
                                .orderBy('timestamp', 'desc')
                                .limit(50);
        }
        const snapshot = await messagesRef.get();
        const pastMessages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            pastMessages.unshift({ ...data, timestamp: data.timestamp.toDate(), id: doc.id }); // En eski mesaj en üstte olacak şekilde sırala
        });
        socket.emit('past messages', { channelId, messages: pastMessages });
    } catch (error) {
        console.error('Geçmiş mesajları çekerken hata:', error);
    }
}

// Tüm kanalları veritabanından çekip gönderen fonksiyon
async function sendChannelList(socket) {
    try {
        const channelsSnapshot = await db.collection('channels').get();
        const channels = [];
        channelsSnapshot.forEach(doc => {
            channels.push({ id: doc.id, ...doc.data() });
        });
        // İstemciye sadece istek atan kullanıcıya gönder
        socket.emit('channel-list', channels);
    } catch (error) {
        console.error('Kanal listesi çekerken hata:', error);
    }
}

// 💡 DÜZELTME: Kullanıcının dahil olduğu tüm DM kanallarını ve diğer katılımcı bilgilerini getiren fonksiyon
async function sendDmHistory(socket, userId) {
  try {
    if (!userId) return console.error('[SUNUCU] sendDmHistory: userId eksik.');

    const dmChannelsSnapshot = await db.collection('dm-channels')
                                        .where('participants', 'array-contains', userId)
                                        .get();
    const dmChannelInfos = [];
    for (const doc of dmChannelsSnapshot.docs) {
        const channelId = doc.id;
        const participants = doc.data().participants;
        const otherUserUid = participants.find(uid => uid !== userId);
        
        if (otherUserUid) {
            const otherUserDoc = await db.collection('users').doc(otherUserUid).get();
            if (otherUserDoc.exists) {
                const otherUserData = otherUserDoc.data();
                dmChannelInfos.push({ id: channelId, nickname: otherUserData.nickname, avatarUrl: otherUserData.avatarUrl, uid: otherUserUid });
            }
        }
    }
    socket.emit('dm history', dmChannelInfos);
    console.log(`[SUNUCU] DM kanalları gönderildi: ${userId} -> ${dmChannelInfos.length} kanal`);
  } catch (error) {
    console.error('DM geçmişi çekerken hata:', error);
  }
}
