/**
 * AuthProvider 契约。
 *
 * 每个 Provider 负责「让一条上游请求带上有效鉴别信息」。
 * Provider 不感知 HTTP 转发细节，只产出 Header/Query 变更。
 */

/**
 * @typedef {Object} SessionState
 * @property {boolean} ok
 * @property {number} [expiresAt]  epoch ms
 * @property {string} [detail]     面向人的状态说明
 */

/**
 * @typedef {Object} Route
 * @property {string} host          对外主机名（含连字符形态）
 * @property {string} [upstreamPort]
 * @property {string} [providerId]
 */

export class AuthProvider {
  /** @type {string} */
  id = 'base';
  /** @type {string} */
  label = 'Base';

  /**
   * 确保会话可用；force=true 强制重登。
   * @param {boolean} [force]
   * @returns {Promise<SessionState>}
   */
  async ensureSession(force = false) {
    throw new Error('not implemented');
  }

  /**
   * 把鉴权信息注入到即将发往上游的请求。
   * @param {{headers: Record<string,string>, query?: URLSearchParams, path: string}} req
   * @param {Route} route
   * @returns {{headers: Record<string,string>, query?: URLSearchParams, path: string}} 修改后应使用新对象
   */
  async applyToRequest(req, route) {
    throw new Error('not implemented');
  }

  /**
   * 上游响应是否是「未登录跳登录页」。
   * @param {number} status
   * @param {string|undefined} location
   */
  isAuthRedirect(status, location) {
    return (
      [301, 302, 307, 308].includes(status) &&
      !!location &&
      /login|account|signin|sign-in|auth/i.test(location)
    );
  }

  /**
   * 可选：按主机换一次性网关 token（UGOS dockerToken）。
   * @param {string} host
   * @param {{force?: boolean}} [opts]
   */
  async renewGatewayToken(host, opts = {}) {
    void host;
    void opts;
    return null;
  }

  /**
   * 给 UI 的脱敏描述。
   */
  describe() {
    return { id: this.id, label: this.label, fields: [] };
  }
}
