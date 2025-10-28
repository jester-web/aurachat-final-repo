const { app, BrowserWindow, ipcMain, session, powerMonitor } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const RPC = require('discord-rpc'); // Discord RPC paketini dahil et

let mainWindow;
let splashWindow;

// 💡 DEĞİŞTİR: Discord Geliştirici Portalından aldığın Application ID'si
// Buraya KENDİ Application ID'nizi yapıştırın!
const CLIENT_ID = '1432555308483481692'; // Örnek ID

const rpc = new RPC.Client({ transport: 'ipc' });
let rpcInterval; 

// --- RPC DURUM GÜNCELLEME FONKSİYONLARI ---
// Bu fonksiyonu arayüz (renderer) ipcMain üzerinden çağıracak.
function updateDiscordPresence(state = 'Uygulama Başlatılıyor...', details = 'Giriş Ekranı', smallImageKey = 'default_icon') { 
    if (!rpc.user) return; // RPC bağlı değilse çık

    rpc.setActivity({
        details: details, // Şu anki eylem (Örn: "Ana Ses Odasında")
        state: state, // Uygulamanın genel durumu (Örn: "Kullanılabilir")
        startTimestamp: Date.now(), // Uygulamayı ne zaman açtın
        largeImageKey: 'aurachat_logo', // Yüklediğin ana ikonun adı
        smallImageKey: smallImageKey, // Küçük durum ikonu
        instance: false,
        buttons: [{ label: 'Ekibe Katıl', url: 'https://aurachat-cyvr.onrender.com' }] 
    }) 
    .catch(err => console.error('[Discord RPC Error]', err));
}

// RPC Bağlantı Mantığı
async function setRpc() {
    try {
        await rpc.login({ clientId: CLIENT_ID });
        console.log('[Discord RPC] Başarıyla bağlandı!'); 
        updateDiscordPresence('Çevrimiçi', 'Hazır!'); 
        
        // Durumu her 15 saniyede bir güncelle
        if (rpcInterval) clearInterval(rpcInterval);
        rpcInterval = setInterval(() => {
            updateDiscordPresence('Çevrimiçi', 'Hazır!');
        }, 15000); 

    } catch (error) {
        console.error('[Discord RPC] Bağlanamadı:', error.message);
    }
}

function createWindow() {
  // Ana uygulama penceresini oluştur
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 650,
    icon: path.join(__dirname, 'icon.png'),
    frame: false, 
    show: false, // Başlangıçta titremeyi önlemek için gizle
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // ipcRenderer kullanmak için gerekli
    }
  });

  // Açılış ekranı (splash) penceresini oluştur.
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'icon.png'),
  });
  splashWindow.loadFile('splash.html');

  // Ana pencere içeriği yüklendiğinde, açılış ekranını kapat ve ana pencereyi göster
  mainWindow.once('ready-to-show', () => { 
    setTimeout(() => {
        splashWindow.destroy();
        mainWindow.show();
    }, 500); // Kısa bir bekleme
  });
  mainWindow.loadFile('index.html'); 
  
}

// Uygulama hazır olduğunda
app.whenReady().then(() => {
  console.log(`[App] Electron uygulaması başlatılıyor... (Sürüm: ${app.getVersion()})`);
  
  // 💡 DÜZELTME: RPC'yi pencere oluşturulmadan önce başlatmak daha güvenilirdir.
  setRpc();

  // 💡 DÜZELTME: Tüm uygulama geneli ayarlar ve olay dinleyicileri buraya taşındı.
  // Bu, pencere oluşturulmadan önce yalnızca bir kez çalışmalarını garanti eder.

  // Medya erişim izinlerini yönet
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'media' && details.mediaTypes?.includes('audio')) {
      callback(true); // Mikrofon isteğini onayla
    } else {
      callback(false); // Diğer tüm istekleri reddet
    }
  });

  // Otomatik güncelleme olaylarını dinle
  autoUpdater.on('update-available', () => {
    if (mainWindow) mainWindow.webContents.send('update_available');
  });
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('update_downloaded');
  });

  // Sistem kapatma olayını dinle
  powerMonitor.on('shutdown', () => {
    console.log('Uygulama kapatılıyor...');
  });

  // Pencere kontrol olaylarını dinle
  ipcMain.on('minimize-app', () => mainWindow?.minimize());
  ipcMain.on('maximize-app', () => { 
    if (mainWindow?.isMaximized()) { mainWindow.unmaximize(); } else { mainWindow?.maximize(); } 
  });
  ipcMain.on('close-app', () => mainWindow?.close());
  ipcMain.on('restart-and-update', () => autoUpdater.quitAndInstall());
  
  // RPC durum güncelleme isteğini dinle
  ipcMain.on('update-rpc-presence', (event, state, details, smallImage) => {
    updateDiscordPresence(state, details, smallImage);
  });

  // Tüm ayarlar yapıldıktan sonra ana pencereyi oluştur.
  createWindow();
  
  autoUpdater.checkForUpdatesAndNotify();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
    if (rpcInterval) clearInterval(rpcInterval);
    if (rpc.user) rpc.destroy();
});
