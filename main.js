const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let splashWindow;

function createWindow() {
  // Açılış ekranı penceresini oluştur
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'icon.png'),
  });
  splashWindow.loadFile('splash.html');

  // Ana uygulama penceresini oluştur ama gösterme
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 650,
    // 💡 YENİ SATIR: Pencere ve görev çubuğu ikonunu ayarlar. Proje ana dizininde 'icon.png' olmalıdır.
    icon: path.join(__dirname, 'icon.png'),
    // 💡 YENİ SATIR: Çerçeveyi ve menü çubuğunu kaldırır.
    frame: false, 
    // ----------------------------------------------------
    show: false, // Pencereyi başlangıçta gizle
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false 
    }
  });

  // Ana pencere içeriği yüklendiğinde, açılış ekranını kapat ve ana pencereyi göster
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => { // Yüklemenin çok hızlı bitmesi durumunda bile splash'in kısa bir süre görünmesi için
        splashWindow.destroy();
        mainWindow.show();
    }, 1500); // Yarım saniye bekle
  });
  mainWindow.loadFile('index.html'); // Ana pencere içeriğini yüklemeye başla

  // --- OTOMATİK GÜNCELLEME ---
  // Geliştirme ortamında loglamayı etkinleştir
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";
  console.log('[Updater] Otomatik güncelleme kontrolü başlatılıyor...');
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    console.log('[Updater] Yeni bir güncelleme mevcut.');
    // Bu olayı dinleyerek arayüzde "Güncelleme bulunuyor..." gibi bir mesaj gösterebilirsiniz.
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[Updater] Yeni güncelleme indirildi. Arayüze haber veriliyor.');
    // Güncelleme indirildiğinde arayüze haber ver.
    mainWindow.webContents.send('update-ready');
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Güncelleme sırasında hata:', err);
  });

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Güncelleme kontrol ediliyor...');
  });

  // Pencere kontrol olaylarını dinle
  ipcMain.on('minimize-app', () => {
    mainWindow.minimize();
  });

  ipcMain.on('maximize-app', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on('close-app', () => {
    mainWindow.close();
  });

  // Arayüzden gelen yeniden başlatma isteğini dinle
  ipcMain.on('restart-and-update', () => {
    autoUpdater.quitAndInstall();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
