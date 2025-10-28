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


async function getAllUsers() {
    const allUsersSnapshot = await db.collection('users').get();
    const allUsers = [];

    allUsersSnapshot.forEach(doc => {
        const userData = doc.data();
        const isOnline = Object.values(onlineUsers).some(onlineUser => onlineUser.uid === userData.uid);
        const socketId = isOnline ? Object.keys(onlineUsers).find(sid => onlineUsers[sid].uid === userData.uid) : null;

        allUsers.push({
            uid: userData.uid,
            nickname: userData.nickname,
            avatarUrl: userData.avatarUrl,
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
          await db.collection('users').doc(userRecord.uid).set({
              nickname,
              avatarUrl: randomAvatar,
              email: email.toLowerCase(),
              uid: userRecord.uid
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

  socket.on('login', async ({ email, password }) => {
      try {
          const userQuery = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
          if (userQuery.empty) {
               socket.emit('auth error', 'E-posta veya şifre hatalı.');
               return;
          }
          const userData = userQuery.docs[0].data();
          const uid = userQuery.docs[0].id;
          
          onlineUsers[socket.id] = { nickname: userData.nickname, avatarUrl: userData.avatarUrl, email: userData.email, socketId: socket.id, uid: uid };
          userStatus[socket.id] = { presence: 'online', muted: false, deafened: false, speaking: false, channel: null }; // 💡 YENİ: Varsayılan durum 'online'
          
          socket.join(TEAM_ID); 

          // 💡 YENİ: Kullanıcı katıldı mesajı gönder
          io.to(TEAM_ID).emit('system message', { message: `${userData.nickname} sohbete katıldı.` });

          // 💡 DÜZELTME: İstemcinin UID'yi alabilmesi için login success olayına uid eklendi.
          socket.emit('login success', { nickname: userData.nickname, avatarUrl: userData.avatarUrl, uid: uid });
          
          console.log(`[SUNUCU] Giriş başarılı: ${userData.nickname}`);

          // 💡 DÜZELTME: Tüm başlangıç verilerinin gönderilmesi beklenip ardından 'initial data loaded' olayı tetikleniyor.
          // Bu, istemcinin yükleme ekranında takılı kalmasını engeller.
          await Promise.all([
              sendChannelList(socket),
              sendPastMessages(socket, MAIN_CHANNEL),
              sendDmHistory(socket, uid),
              getAllUsers().then(users => io.to(TEAM_ID).emit('user list', users))
          ]);
          socket.emit('initial data loaded');

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
    const user = onlineUsers[socket.id];
    if (!user || !userStatus[socket.id]) return;

    // 'online', 'idle', 'dnd', 'invisible' gibi geçerli durumları kontrol et
    const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
    if (validStatuses.includes(newStatus)) {
        userStatus[socket.id].presence = newStatus;
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
