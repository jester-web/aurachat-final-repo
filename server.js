const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path'); 
const multer = require('multer');

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

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir);

app.use('/uploads', express.static(uploadsDir));

const avatarStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, avatarsDir) },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadAvatar = multer({ storage: avatarStorage });


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


const onlineUsers = {};
const userStatus = {};      
const AVATAR_URLS = [ 'https://i.pravatar.cc/150?img=1', 'https://i.pravatar.cc/150?img=2', 'https://i.pravatar.cc/150?img=3', 'https://i.pravatar.cc/150?img=4', 'https://i.pravatar.cc/150?img=5' ];


function getOnlineUsers() {
    return Object.values(onlineUsers)
        .map(u => ({ 
            nickname: u.nickname, 
            socketId: u.socketId,
            avatarUrl: u.avatarUrl,
            status: userStatus[u.socketId] || {},
            uid: u.uid
        }));
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
          userStatus[socket.id] = { muted: false, deafened: false, speaking: false, channel: null };
          
          socket.join(TEAM_ID); 
          
          socket.emit('login success', { nickname: userData.nickname, avatarUrl: userData.avatarUrl });
          
          console.log(`[SUNUCU] Giriş başarılı: ${userData.nickname}`);
          io.to(TEAM_ID).emit('user list', getOnlineUsers());

      } catch (err) {
          console.error('Giriş hatası:', err.message);
          socket.emit('auth error', 'Giriş sırasında bir hata oluştu.');
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
        
        await userRef.update({
            nickname: newNickname,
            avatarUrl: newAvatarUrl || user.avatarUrl
        });

        user.nickname = newNickname;
        user.avatarUrl = newAvatarUrl || user.avatarUrl;
        
        await auth.updateUser(user.uid, { displayName: newNickname, photoURL: newAvatarUrl });

        socket.emit('profile update success', { nickname: user.nickname, avatarUrl: user.avatarUrl });
        io.to(TEAM_ID).emit('user list', getOnlineUsers());

    } catch(err) {
        console.error('Profil güncelleme hatası:', err.message);
        socket.emit('profile update error', 'Profil güncellenirken bir hata oluştu.');
    }
  });


  // ------------------------------------
  // CHAT, SES ve DİĞER FONKSİYONLAR
  // ------------------------------------
  
  socket.on('chat message', (data) => { /* ... */ });
  socket.on('join voice channel', (channelId) => { /* ... */ });
  socket.on('leave voice channel', (channelId) => { /* ... */ });
  socket.on('toggle status', (data) => { /* ... */ });
  socket.on('toggle speaking', (isSpeaking) => { 
    const user = onlineUsers[socket.id];
    if (!user) return;
    userStatus[socket.id].speaking = isSpeaking; 
    io.to(TEAM_ID).emit('user list', getOnlineUsers());
  });
  
  // WebRTC Sinyalleşmesi
  socket.on('offer', (id, message) => { socket.to(id).emit('offer', socket.id, message); });
  socket.on('answer', (id, message) => { socket.to(id).emit('answer', socket.id, message); });
  socket.on('candidate', (id, message) => { socket.to(id).emit('candidate', socket.id, message); });
  
  // Kullanıcı bağlantıyı kestiğinde
  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    
    delete onlineUsers[socket.id]; 
    delete userStatus[socket.id]; 
    
    io.to(TEAM_ID).emit('user list', getOnlineUsers());
  });
});

// RENDER İÇİN PORT AYARI
const RENDER_PORT = process.env.PORT || PORT;
server.listen(RENDER_PORT, () => {
  console.log(`[SUNUCU BAŞARILI] AuraChat port ${RENDER_PORT}'da çalışıyor.`);
});