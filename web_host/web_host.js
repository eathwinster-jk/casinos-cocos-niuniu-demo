// 网页宿主登录层，登录成功后向 Cocos 注入真实大厅会话。
(function initializeWebHost(global) {
  'use strict';
  const SESSION_KEY = 'cocos_web_game_session_v1';
  const SESSION_ERROR_KEY = 'cocos_web_game_session_error';
  const LOGIN_FORM_KEY = 'cocos_web_login_form_v1';
  const LOGIN_PATH = '/prod-api/login';
  const LOBBY_PATH = '/game-lobby';
  const PRODUCT_ID = '4';
  const CLIENT_VERSION = '1.120';
  const SCENE_TYPE = 2;
  const SCENE_ID = '0999000015';
  let startGameCallback = null;
  let loginMode = 'account';

  /**
   * 将未知异常转换为标准错误。
   */
  function normalizeError(error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * 获取必需的宿主页面元素。
   */
  function getElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`宿主登录页缺少元素：${id}`);
    return element;
  }

  /**
   * 读取 JSON 响应并保留服务端提示。
   */
  async function requestJson(url, options, context) {
    try {
      const response = await fetch(url, options);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.msg || `${context}失败，HTTP ${response.status}`);
      return payload;
    } catch (error) {
      const normalized = normalizeError(error);
      console.error(`${context}异常`, { url: String(url), error: normalized });
      throw normalized;
    }
  }

  /**
   * 使用账号密码换取业务 UID 和 Token。
   */
  async function authenticate(account, password) {
    const url = new URL(LOGIN_PATH, global.location.origin);
    url.searchParams.set('account', account);
    url.searchParams.set('password', password);
    url.searchParams.set('apptype', '1');
    url.searchParams.set('pid', PRODUCT_ID);
    url.searchParams.set('countryCode', '86');
    const payload = await requestJson(url, {
      method: 'GET',
      headers: { pid: PRODUCT_ID, version: CLIENT_VERSION },
    }, '账号登录');
    if (String(payload.code) !== '0') throw new Error(payload.msg || '登录失败');
    return parseLoginSession(payload);
  }

  /**
   * 校验登录响应中的 UID 和 Token。
   */
  function parseLoginSession(payload) {
    const userId = Number(payload.uid);
    const token = typeof payload.token === 'string' ? payload.token.trim() : '';
    if (!Number.isSafeInteger(userId) || userId <= 0 || token.length === 0) {
      throw new Error('登录响应缺少有效 UID 或 Token');
    }
    return { userId, token };
  }

  /**
   * 读取当前登录模式对应的会话凭据。
   */
  async function resolveLoginSession() {
    if (loginMode === 'token') {
      const uid = getElement('WebLoginUid').value.trim();
      const token = getElement('WebLoginToken').value.trim();
      if (!uid || !token) throw new Error('请输入 UID 和 Token');
      return parseLoginSession({ uid, token });
    }
    const account = getElement('WebLoginAccount').value.trim();
    const password = getElement('WebLoginPassword').value;
    if (!account || !password) throw new Error('请输入账号和密码');
    return authenticate(account, password);
  }

  /**
   * 切换账号密码或 UID Token 登录模式。
   */
  function setLoginMode(mode) {
    loginMode = mode === 'token' ? 'token' : 'account';
    const isTokenMode = loginMode === 'token';
    getElement('WebAccountFields').classList.toggle('web-login-fields-hidden', isTokenMode);
    getElement('WebTokenFields').classList.toggle('web-login-fields-hidden', !isTokenMode);
    getElement('WebAccountTab').classList.toggle('is-active', !isTokenMode);
    getElement('WebTokenTab').classList.toggle('is-active', isTokenMode);
    showMessage('', false);
    saveLoginForm();
  }

  /**
   * 读取上次测试登录表单，便于切换 UID Token。
   */
  function loadLoginForm() {
    const text = global.localStorage.getItem(LOGIN_FORM_KEY);
    if (!text) return;
    try {
      const form = JSON.parse(text);
      if (typeof form.account === 'string') getElement('WebLoginAccount').value = form.account;
      if (typeof form.password === 'string') getElement('WebLoginPassword').value = form.password;
      if (typeof form.uid === 'string') getElement('WebLoginUid').value = form.uid;
      if (typeof form.token === 'string') getElement('WebLoginToken').value = form.token;
      setLoginMode(form.mode === 'token' ? 'token' : 'account');
    } catch (error) {
      console.error('读取网页登录表单失败', normalizeError(error));
    }
  }

  /**
   * 保存当前测试登录表单。
   */
  function saveLoginForm() {
    global.localStorage.setItem(LOGIN_FORM_KEY, JSON.stringify({
      mode: loginMode,
      account: getElement('WebLoginAccount').value.trim(),
      password: getElement('WebLoginPassword').value,
      uid: getElement('WebLoginUid').value.trim(),
      token: getElement('WebLoginToken').value.trim(),
    }));
  }

  /**
   * 创建 Cocos 可读取的大厅连接配置。
   */
  function createLobbyConfig(session) {
    return {
      websocketUrl: 'wss://test.imnono.net/game-ws/ws',
      apiBaseUrl: `${global.location.origin}${LOBBY_PATH}`,
      liveUserId: session.userId,
      liveToken: session.token,
      sceneType: SCENE_TYPE,
      sceneId: SCENE_ID,
      clientVersion: CLIENT_VERSION,
      deviceType: 'Web',
    };
  }

  /**
   * 登录后先请求大厅桌台，确认会话可用。
   */
  async function validateLobby(config) {
    const payload = await requestJson(`${config.apiBaseUrl}/api/lobby/table/by-scene`, {
      method: 'POST',
      headers: createLobbyHeaders(config),
      body: JSON.stringify({ sceneType: config.sceneType, sceneId: config.sceneId }),
    }, '游戏大厅校验');
    if (Number(payload.code) !== 0 || payload.data === undefined) {
      throw new Error(payload.msg || '游戏大厅校验失败');
    }
    const selected = pickSceneTable(payload.data);
    if (!selected || selected.tableId === undefined) {
      throw new Error('游戏大厅没有可用牛牛桌');
    }
    config.tableId = Number(selected.tableId);
    console.warn('大厅校验当前桌', JSON.stringify({
      tableId: config.tableId,
      gameCode: selected.gameCode,
      tableStatus: selected.tableStatus,
    }));
  }

  /**
   * 从大厅场景桌列表中选取牛牛桌。
   */
  function pickSceneTable(data) {
    const tables = Array.isArray(data) ? data : [];
    return tables.find(function findNiuNiu(table) {
      return table && table.gameCode === 'bull_banker';
    }) || tables[0];
  }

  /**
   * 创建大厅身份请求头。
   */
  function createLobbyHeaders(config) {
    return {
      'Content-Type': 'application/json',
      'live-user-id': String(config.liveUserId),
      'live-user-token': config.liveToken,
    };
  }

  /**
   * 将有效会话保存到当前浏览器标签页。
   */
  function saveSession(config) {
    global.sessionStorage.setItem(SESSION_KEY, JSON.stringify(config));
  }

  /**
   * 读取当前标签页保存的会话。
   */
  function loadSession() {
    const text = global.sessionStorage.getItem(SESSION_KEY);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error('读取网页游戏会话失败', normalizeError(error));
      clearSession();
      return null;
    }
  }

  /**
   * 清除失效会话。
   */
  function clearSession() {
    global.sessionStorage.removeItem(SESSION_KEY);
    global.__cocosLobbyConfig = undefined;
  }

  /**
   * 更新宿主登录状态文字。
   */
  function showMessage(message, isError) {
    const status = getElement('WebLoginStatus');
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  /**
   * 切换登录按钮加载状态。
   */
  function setLoading(isLoading) {
    const button = getElement('WebLoginButton');
    button.disabled = isLoading;
    button.textContent = isLoading ? '登录中…' : '登录';
  }

  /**
   * 启动 Cocos 并隐藏宿主登录页。
   */
  async function launchGame(config) {
    if (!startGameCallback) throw new Error('宿主页尚未设置 Cocos 启动回调');
    global.__cocosLobbyConfig = config;
    saveSession(config);
    document.body.classList.add('web-game-started');
    await startGameCallback();
  }

  /**
   * 处理宿主账号密码表单提交。
   */
  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    showMessage('', false);
    try {
      const session = await resolveLoginSession();
      saveLoginForm();
      const config = createLobbyConfig(session);
      await validateLobby(config);
      await launchGame(config);
    } catch (error) {
      clearSession();
      showMessage(normalizeError(error).message, true);
      setLoading(false);
    }
  }

  /**
   * 会话被 WebSocket 拒绝时返回宿主登录页。
   */
  function handleSessionInvalid(message) {
    clearSession();
    global.sessionStorage.setItem(SESSION_ERROR_KEY, message || '游戏会话已失效，请重新登录');
    global.location.reload();
  }

  /**
   * 尝试恢复当前标签页中的有效会话。
   */
  async function restoreSession() {
    const savedConfig = loadSession();
    if (!savedConfig) return false;
    const config = { ...savedConfig };
    try {
      await validateLobby(config);
      await launchGame(config);
      return true;
    } catch (error) {
      console.error('恢复网页游戏会话失败', normalizeError(error));
      clearSession();
      return false;
    }
  }

  /**
   * 初始化独立宿主登录层。
   */
  async function start(options) {
    startGameCallback = options.startGame;
    getElement('WebLoginForm').addEventListener('submit', handleSubmit);
    getElement('WebAccountTab').addEventListener('click', () => setLoginMode('account'));
    getElement('WebTokenTab').addEventListener('click', () => setLoginMode('token'));
    loadLoginForm();
    global.__cocosLobbySessionInvalid = handleSessionInvalid;
    const errorMessage = global.sessionStorage.getItem(SESSION_ERROR_KEY);
    global.sessionStorage.removeItem(SESSION_ERROR_KEY);
    if (errorMessage) showMessage(errorMessage, true);
    await restoreSession();
  }

  /**
   * 允许已有网站直接传入登录后会话并启动游戏。
   */
  async function launchWithSession(session) {
    const config = createLobbyConfig(session);
    await validateLobby(config);
    await launchGame(config);
  }

  global.CocosWebGameHost = Object.freeze({ start, launchWithSession, clearSession });
}(window));
