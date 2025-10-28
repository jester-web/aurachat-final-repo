const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process'); // 💡 YENİ: Node.js sunucusunu başlatmak için

// Uygulamanın canlı yeniden yüklemesini geliştirme ortamında etkinleştirir.
// Bu satırı production'a geçerken kaldırabilir veya yorum satırı yapabilirsiniz.
try {
    require('electron-reloader')(module);
} catch (_) {}

// 💡 YENİ: Sunucu işlemini tutmak için bir değişken
let serverProcess;

let mainWindow;
let splashWindow;

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 400,
        height: 300,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        center: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        }
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

function createWindow() {
    // Ana uygulama penceresini oluştur.
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 940,
        minHeight: 560,
        show: false, // Pencereyi başlangıçta gösterme
        frame: false, // İşletim sisteminin varsayılan çerçevesini kaldır
        titleBarStyle: 'hidden',
        backgroundColor: '#111214',
        webPreferences: {
            nodeIntegration: true, // `require` gibi Node.js özelliklerini kullanabilmek için
            contextIsolation: false, // `require`'ı doğrudan renderer'da kullanmak için (güvenlik notlarına dikkat)
            // preload: path.join(__dirname, 'preload.js') // Güvenliği artırmak için preload script'i kullanmak daha iyidir, şimdilik bu şekilde bırakıyoruz.
        },
        icon: path.join(__dirname, 'icon.png') // Uygulama ikonu
    });

    // ve uygulamanın index.html'ini yükle.
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Ana pencere içeriği tamamen yüklendiğinde ve gösterilmeye hazır olduğunda
    mainWindow.once('ready-to-show', () => {
        if (splashWindow) {
            splashWindow.close();
        }
        mainWindow.show();
    });

    // Pencere kapatıldığında çalışır.
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Bu metod, Electron başlatıldığında ve tarayıcı pencerelerini
// oluşturmaya hazır olduğunda çağrılacak.
app.on('ready', () => {
    // 💡 YENİ: Sunucuyu ayrı bir işlem olarak başlat
    console.log('Starting server...');
    serverProcess = fork(path.join(__dirname, 'server.js'), [], { silent: false });

    createSplashWindow();

    // 💡 YENİ: Sunucudan 'hazırım' mesajını bekle
    serverProcess.on('message', (message) => {
        if (message === 'server-ready') {
            createWindow(); // Sunucu hazır olduğunda ana pencereyi oluştur
        }
    });
});

// Tüm pencereler kapatıldığında uygulamadan çık.
app.on('window-all-closed', () => {
    // macOS'te kullanıcı Cmd + Q ile çıkana kadar uygulamaların
    // ve menü çubuğunun aktif kalması yaygındır.
    if (process.platform !== 'darwin') {
        // 💡 YENİ: Uygulama kapanırken sunucu işlemini de sonlandır
        if (serverProcess) {
            serverProcess.kill();
        }
        app.quit();
    }
});

app.on('activate', () => {
    // macOS'te dock'taki ikona tıklandığında ve başka pencere
    // açık olmadığında yeni bir pencere oluşturmak yaygındır.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// --- IPC (Renderer Process ile İletişim) ---

// Kapatma, küçültme ve büyütme butonları için olay dinleyicileri
ipcMain.on('minimize-app', () => {
    mainWindow.minimize();
});

ipcMain.on('maximize-app', () => {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

ipcMain.on('close-app', () => {
    mainWindow.close();
});
