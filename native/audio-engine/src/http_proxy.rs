//! 通用 HTTP 代理，通过 NAPI 暴露给主进程。
//! 使用 wreq + BoringSSL 模拟浏览器 TLS/JA3/JA4/HTTP2 指纹，防止反爬封禁。

use std::collections::HashMap;
use std::sync::OnceLock;
use tracing::debug;
use wreq::Client;
use wreq_util::Emulation;

/// HTTP 响应
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

/// 全局复用的 wreq Client，模拟 Firefox 136 指纹
fn global_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .emulation(Emulation::Firefox136)
            .build()
            .expect("wreq Client 初始化失败")
    })
}

/// 异步 HTTP GET
pub async fn do_get(url: &str, headers: &HashMap<String, String>) -> Result<ProxyResponse, String> {
    let client = global_client();
    let mut req = client.get(url);
    for (key, value) in headers {
        req = req.header(key.as_str(), value.as_str());
    }
    debug!(url_len = url.len(), "HTTP 代理 GET");
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    read_response(resp).await
}

/// 异步 HTTP POST
pub async fn do_post(
    url: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<ProxyResponse, String> {
    let client = global_client();
    let mut req = client.post(url);
    for (key, value) in headers {
        req = req.header(key.as_str(), value.as_str());
    }
    debug!(url_len = url.len(), "HTTP 代理 POST");
    let resp = req
        .body(body.to_owned())
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    read_response(resp).await
}

/// 提取响应头和 body（先收集 headers 再消费 body）
async fn read_response(resp: wreq::Response) -> Result<ProxyResponse, String> {
    let status = resp.status().as_u16();
    let mut resp_headers = Vec::new();
    for (name, value) in resp.headers().iter() {
        if let Ok(v) = value.to_str() {
            resp_headers.push((name.as_str().to_string(), v.to_string()));
        }
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(ProxyResponse {
        status,
        body,
        headers: resp_headers,
    })
}
