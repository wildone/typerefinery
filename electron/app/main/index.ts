import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  dialog,
  // Menu,
  // MenuItem,
  // nativeImage,
  crashReporter,
  shell,
} from "electron"
import * as path from "path"
import i18n from "./i18n"
import dotenv, { config } from "dotenv"
import { ServiceManager } from "./ServiceManager"
import { Logger } from "./Logger"
import {
  dataPath,
  isFirstInstall,
  createFirstInstallFile,
  // resourceBinary
} from "./Resources"
import log from "electron-log"
import { CaptureConsole } from "@sentry/integrations"
// import { type Integration } from "@sentry/types"
import * as Sentry from "@sentry/electron"
// import contextMenu from "electron-context-menu"
import { release } from "os"
import internal from "stream"
import { getConfig, getEnvConfigWithDefault, tryParseInt } from "./Utils"
import ElectronWindowState from "electron-window-state"
import { t } from "i18next"
import { type AppIPC, sharedAppIpc } from "../preload/ipc"
import { Service } from "./Service"

import updateElectronApp from "update-electron-app"

// setup crash reporter first
if (getEnvConfigWithDefault("CRASH_REPORTER_SUBMIT_URL")) {
  // Start crash reporter before setting up logging
  crashReporter.start({
    companyName: config["companyName"],
    productName: config["productName"],
    ignoreSystemCrashHandler: true,
    submitURL: getEnvConfigWithDefault("CRASH_REPORTER_SUBMIT_URL"),
  })
}

let logsDir = dataPath("logs")

// tarack when the main window is closing
let mainWindowClosing = false

// create a new logs sub directory with date timestamp everytime the app starts
const date = new Date()
const dateStr = date
  .toISOString()
  .replace(/:/g, "-")
  .replace(/.Z/g, "")
  .replace(/T/g, "_")
logsDir = path.join(logsDir, dateStr)

// Setup logging to file after crash reporter.
Object.assign(console, log.functions)
log.transports.file.resolvePath = () => path.join(logsDir, "main.log")
const logger = new Logger(logsDir, "electron")

// Setup error logging
if (getEnvConfigWithDefault("CRASH_REPORTER_SUBMIT_URL")) {
  if (app.isPackaged) {
    Sentry.init({
      dsn: getEnvConfigWithDefault("ERROR_REPORT_SENTURY_DSN"),
      sampleRate: 1.0,
      integrations: [
        new CaptureConsole({
          levels: getEnvConfigWithDefault("ERROR_REPORT_LEVEL"),
        }) as any,
      ],
    })
  }
}

//support .env file
dotenv.config()

logger.log(`app.isPackaged: ${app.isPackaged}`)
//variables
let isDev = !app.isPackaged
const envMode = getEnvConfigWithDefault("NODE_ENV", "")
if (envMode != "") {
  isDev = envMode === "dev"
}

logger.log(`isDev: ${isDev}`)
logger.log(
  `getEnvConfigWithDefault("NODE_ENV", "production"): ${getEnvConfigWithDefault(
    "NODE_ENV",
    "production"
  )}`
)

if (!isDev) {
  // run auto update
  updateElectronApp({
    repo: "typerefinery-ai/typerefinery",
    updateInterval: "1 hour",
  })
}

let mainWindow: BrowserWindow
let mainWindowState: ElectronWindowState.State
let tray: Tray
const VITE_DEV_SERVER_HOST = getEnvConfigWithDefault(
  "VITE_DEV_SERVER_HOST",
  "localhost"
)
const VITE_DEV_SERVER_PORT: number = tryParseInt(
  getEnvConfigWithDefault("VITE_DEV_SERVER_PORT", "3000"),
  3000
)

const VITE_DEV_SERVER_SCHEMA = getEnvConfigWithDefault(
  "VITE_DEV_SERVER_SCHEMA",
  "http"
)
const LOCAL_SERVICES_PATH: string = getEnvConfigWithDefault(
  "LOCAL_SERVICES_PATH",
  ""
)
const LOCAL_SERVICES_USERDATA_PATH: string = dataPath(
  getEnvConfigWithDefault("LOCAL_SERVICES_USERDATA_PATH", "")
)
const SCRIPT_PRELOAD = path.join(__dirname, "../preload/index.cjs")
logger.log(`SCRIPT_PRELOAD: ${SCRIPT_PRELOAD}`)

// Disable GPU Acceleration for Windows 7
if (release().startsWith("6.1")) {
  app.disableHardwareAcceleration()
}

// Set application name for Windows 10+ notifications
if (process.platform === "win32") {
  app.setAppUserModelId(getConfig("productName"))
}

//only allow one instance of the app and focus main window if already running
const appMainInstanceLock = app.requestSingleInstanceLock()
if (!appMainInstanceLock) {
  app.quit()
  process.exit(0)
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    }
  })
}

logger.log(`isDev: ${isDev}`)

// service manager
const serviceManager = new ServiceManager(
  logsDir,
  logger,
  LOCAL_SERVICES_PATH,
  LOCAL_SERVICES_USERDATA_PATH,
  {
    sendServiceStatus,
    sendServiceLog,
  },
  {
    sendServiceList,
    sendGlobalEnv,
  }
)

function sendGlobalEnv(globalenv: { [key: string]: string }) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send("sendGlobalEnv", globalenv)
    logger.log("sendGlobalEnv", globalenv)
  }
}

function sendServiceList(serviceConfigList: Service[]) {
  logger.log(
    `sendServiceList: ${serviceConfigList.map((x) => x.id).toString()}`
  )
}

function sendServiceStatus(id: string, output: string) {
  // dont run this if the app is closing
  logger.log("sendServiceStatus index", id, output)
  if (
    !mainWindowClosing &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  ) {
    try {
      mainWindow.webContents.send("sendServiceStatus", { id, output })
      logger.log("sendServiceStatus", id, output)
    } catch (e) {
      logger.log(
        "sendServiceStatus could not send event to mainWindow.webContents, error",
        e
      )
    }
  }
}

function sendServiceLog(id: string, output: string) {
  logger.log("sendServiceLog", id, output)
}

// electron config
async function createWindow() {
  logger.log(`createWindow`)

  // set default window state
  mainWindowState = ElectronWindowState({
    defaultHeight: +getConfig("appHeight"),
    defaultWidth: getConfig("appWidth"),
  })

  // Create the browser window.
  mainWindow = new BrowserWindow({
    ...mainWindowState,
    minWidth: 680,
    minHeight: 400,
    show: false,
    frame: false,
    icon: path.join(__dirname, "assets/icon.ico"),
    webPreferences: {
      preload: SCRIPT_PRELOAD,
      nodeIntegration: true,
      contextIsolation: true,
      spellcheck: true,
    },
  })
  // mainWindowState.manage(mainWindow)

  addIpcEvents(mainWindow)

  logger.log(`app.isPackaged: ${app.isPackaged}`)

  //disable X-Frame-Options when frame name is disable-x-frame-options
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    (details, callback) => {
      if (details && details.responseHeaders) {
        if (details.responseHeaders["X-Frame-Options"]) {
          delete details.responseHeaders["X-Frame-Options"]
        } else if (details.responseHeaders["x-frame-options"]) {
          delete details.responseHeaders["x-frame-options"]
        }
      }
      callback({ cancel: false, responseHeaders: details.responseHeaders })
    }
  )

  // logger.log(`isDev: ${isDev}`)
  // // Open the DevTools.
  // if (isDev) {
  //   mainWindow.webContents.openDevTools()
  // }
  // mainWindow.webContents.openDevTools()

  loadResource(mainWindow, "../index.html", "")

  //splash screen
  const splash = new BrowserWindow({
    width: 500,
    height: 550,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
  })

  splash.loadURL(path.join(__dirname, "loader/splash.html"))
  splash.center()
  setTimeout(function () {
    splash.close()
    mainWindowState.manage(mainWindow)
    mainWindow.center()
    mainWindow.show()
  }, 2000)

  //tray
  tray = new Tray(path.join(__dirname, "assets/tray_icon.png"))

  tray.setToolTip(getConfig("productName"))

  tray.on("click", () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  logger.log("app.whenReady")
  createWindow()
  app.on("activate", function () {
    logger.log("app on activate")
    const allWindows = BrowserWindow.getAllWindows()
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (allWindows.length) {
      allWindows[0].focus()
    } else {
      createWindow()
    }
  })

  ipcMain.on("menu-click", (e, action) => {
    logger.log("ipc menu-click", action)
    if (action === "min") {
      mainWindow.minimize()
    } else if (action === "max") {
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    } else if (action === "close") {
      mainWindow.close()
    }
  })

  ipcMain.on("lang-change", (e, lang) => {
    logger.log("ipc lang-change", lang)
    i18n.changeLanguage(lang)
    mainWindow.setTitle(i18n.t("app.title"))
  })

  mainWindow.on("close", function (e) {
    mainWindowClosing = true
    logger.log("mainWindow.on close")
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: [
        i18n.t("prompt.quit"),
        i18n.t("prompt.no"),
        i18n.t("prompt.minimize"),
      ],
      title: i18n.t("prompt.confirm"),
      message: i18n.t("prompt.msg"),
      defaultId: 1,
      cancelId: 1,
    })
    if (choice === 0) {
      mainWindow.webContents.send("sendServiceStopped")
      serviceManager.stopAll()
    } else if (choice === 1) {
      e.preventDefault()
      //Dialog will be closed by clicking "X" button.
    } else {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  // wait for window to be ready before loading services.
  mainWindow.webContents.on("did-finish-load", function () {
    logger.log("mainWindow.webContents.on did-finish-load")
    // check installed.txt file exists
    const isFirstRun = isFirstInstall()
    logger.log(`first run: ${isFirstRun}`)
    logger.log(`mainWindow.webContents.on did-finish-load startAll.`)
    serviceManager.startAll(isFirstRun)
    // create file installed.txt
    if (isFirstRun) {
      logger.log("create first run file.")
      createFirstInstallFile()
      logger.log(`next run will be first run?: ${isFirstInstall()}`)
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  logger.log("app window-all-closed")
  serviceManager.stopAll()
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// new window example arg: new windows url
ipcMain.handle("open-win", (event, arg) => {
  logger.log("ipc open-win")
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload: SCRIPT_PRELOAD,
    },
  })

  loadResource(childWindow, "../index.html", arg)
})

function loadResource(window: BrowserWindow, uri: string, arg: any) {
  logger.log(`loadResource: ${uri}, ${arg}`)
  if (isDev) {
    const urlArgs = arg ? `#${arg}` : ""
    const url = `${VITE_DEV_SERVER_SCHEMA}://${VITE_DEV_SERVER_HOST}:${VITE_DEV_SERVER_PORT}/${urlArgs}`
    logger.log(`loadurl: ${url}`)
    window.loadURL(url)
  } else {
    logger.log(`loadfile: ${path.join(__dirname, `${uri}`)}, ${arg}`)
    window.loadFile(path.join(__dirname, `${uri}`), {
      hash: `${arg}`,
    })
  }
  // window.webContents.openDevTools()
}

function addIpcEvents(window: BrowserWindow) {
  const ipcImplementation: AppIPC = {
    isAuthenticated() {
      logger.log("ipc isAuthenticated")
      return true
    },
    minimize() {
      logger.log("ipc minimize")
      window?.minimize()
    },
    maximize() {
      logger.log("ipc maximize")
      window?.maximize()
    },
    unmaximize() {
      logger.log("ipc unmaximize")
      window?.unmaximize()
    },
    close() {
      logger.log("ipc close")
      window?.close()
    },
    isMaximized() {
      logger.log("ipc isMaximized")
      return window?.isMaximized() ?? false
    },
    isMinimized() {
      logger.log("ipc isMinimized")
      return window?.isMinimized() ?? false
    },
    isNormal() {
      logger.log("ipc isNormal")
      return window?.isNormal() ?? false
    },
    setBadgeCount(n: number) {
      logger.log(`ipc setBadgeCount ${n}`)
      return app.setBadgeCount(n)
    },
    getServices() {
      logger.log(`ipc getServices`)
      return serviceManager.getServicesSimple()
    },
    //app path
    getAppPath(): any {
      const appPath = app.getPath("exe")
      logger.log(`app.appPath: ${appPath}`)
      return appPath
    },
    //App data path
    getAppDataPath(): any {
      const appAppDataPath = app.getPath("appData") + `\\TypeRefinery`
      logger.log(`app.appLogs: ${appAppDataPath}`)
      return appAppDataPath
    },
    getDirectory(path): any {
      shell.showItemInFolder(path) // Show the given file in a file manager. If possible, select the file.
      // shell.openPath(path)
    },
    async restartService(serviceid: string): Promise<any> {
      logger.log(`ipc restartService {serviceid}`)
      const aservice = serviceManager.getService(serviceid)
      if (aservice) {
        await aservice.stop()
        await aservice.start()
      } else {
        logger.log(`service {serviceid} not found`)
        return false
      }
      return true
    },
    async startService(serviceid: string): Promise<any> {
      logger.log(`ipc startService {serviceid}`)
      const aservice = serviceManager.getService(serviceid)
      if (aservice) {
        await aservice.start()
      } else {
        logger.log(`service {serviceid} not found`)
        return false
      }
      return true
    },
    stopService(serviceid: string): any {
      logger.log(`ipc stopService {serviceid}`)
      const aservice = serviceManager.getService(serviceid)
      if (aservice) {
        aservice.stop()
      } else {
        logger.log(`service {serviceid} not found`)
        return false
      }
      return true
    },
    startAll(): any {
      logger.log(`ipc startAll`)
      const isFirstRun = isFirstInstall()
      logger.log(`first run: ${isFirstRun}`)
      serviceManager.startAll(isFirstRun)
      // create file installed.txt
      if (isFirstRun) {
        logger.log("create first run file.")
        createFirstInstallFile()
        logger.log(`next run will be first run?: ${isFirstInstall()}`)
      }
    },
    stopAll(): any {
      logger.log(`ipc stopAll`)
      serviceManager.stopAll()
    },
    getGlobalEnv(): any {
      logger.log(`ipc getGlobalEnv`)
      return serviceManager.getGlobalEnv()
    },
  }

  Object.values(sharedAppIpc).forEach((method) => method.clean())
  Object.entries(ipcImplementation).forEach(([channel, implementation]) => {
    sharedAppIpc[channel as keyof AppIPC].implement(
      implementation.bind(ipcImplementation) as any
    )
  })
}
