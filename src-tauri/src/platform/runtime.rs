use reqwest::{Client, Method, Response, StatusCode};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

pub(crate) const MAX_JSON_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_ERROR_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_JSON_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_GENERATION_TOKENS: i64 = 16_384;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(20 * 60);

pub(crate) const OLLAMA_LOCAL_BASE_URL: &str = "http://127.0.0.1:11434";
pub(crate) const OLLAMA_KEEP_ALIVE: &str = "30m";

pub(crate) type RuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Shared model-runtime boundary consumed by both product shells.
///
/// The first implementation intentionally exposes only the operations already
/// used by Ollmin. A future enterprise adapter can implement this contract
/// without adding network configuration to the product UI.
pub(crate) trait ModelRuntime: Send + Sync {
    fn health(&self) -> RuntimeFuture<'_, Result<Value, String>>;
    fn list_models(&self) -> RuntimeFuture<'_, Result<Value, String>>;
    fn loaded_models(&self) -> RuntimeFuture<'_, Result<Value, String>>;
    fn warm_model(&self, model: String) -> RuntimeFuture<'_, Result<Value, String>>;
    fn chat_once(&self, body: Value) -> RuntimeFuture<'_, Result<Value, String>>;
    fn chat(&self, body: Value) -> RuntimeFuture<'_, Result<Response, String>>;
}

#[derive(Clone)]
pub(crate) struct OllamaLocalAdapter {
    client: Client,
}

impl Default for OllamaLocalAdapter {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(DEFAULT_REQUEST_TIMEOUT)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("固定的本机 Ollama 客户端配置无效"),
        }
    }
}

impl OllamaLocalAdapter {
    async fn request_json_impl(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let url = format!("{OLLAMA_LOCAL_BASE_URL}{path}");
        let mut request = self.client.request(method, url);
        if let Some(payload) = body {
            let payload_bytes = serde_json::to_vec(&payload)
                .map_err(|error| format!("序列化 Ollama 请求失败：{error}"))?;
            if payload_bytes.len() > MAX_JSON_REQUEST_BYTES {
                return Err(format!(
                    "Ollama 请求超过 {} MiB 限制",
                    MAX_JSON_REQUEST_BYTES / 1024 / 1024
                ));
            }
            request = request.json(&payload);
        }

        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        let response_limit = if status.is_success() {
            MAX_JSON_RESPONSE_BYTES
        } else {
            MAX_ERROR_RESPONSE_BYTES
        };
        let response_text = read_response_text_limited(response, response_limit).await?;

        if status != StatusCode::OK {
            let detail = if response_text.trim().is_empty() {
                status.to_string()
            } else {
                response_text
            };
            return Err(format!("Ollama 返回 {status}：{detail}"));
        }

        serde_json::from_str(&response_text)
            .map_err(|error| format!("Ollama 返回了无法解析的 JSON：{error}"))
    }
}

fn validate_chat_body(body: &Value) -> Result<(), String> {
    let num_predict = body
        .get("options")
        .and_then(Value::as_object)
        .and_then(|options| options.get("num_predict"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "Ollama 聊天请求必须设置有限的 num_predict".to_string())?;
    if !(1..=MAX_GENERATION_TOKENS).contains(&num_predict) {
        return Err(format!(
            "Ollama 聊天请求的 num_predict 必须在 1 至 {MAX_GENERATION_TOKENS} 之间"
        ));
    }
    Ok(())
}

pub(crate) async fn read_response_text_limited(
    mut response: Response,
    maximum_bytes: usize,
) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(format!("Ollama 响应超过 {maximum_bytes} 字节限制"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取 Ollama 响应失败：{error}"))?
    {
        if body.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(format!("Ollama 响应超过 {maximum_bytes} 字节限制"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

impl ModelRuntime for OllamaLocalAdapter {
    fn health(&self) -> RuntimeFuture<'_, Result<Value, String>> {
        Box::pin(self.request_json_impl(Method::GET, "/api/version", None))
    }

    fn list_models(&self) -> RuntimeFuture<'_, Result<Value, String>> {
        Box::pin(self.request_json_impl(Method::GET, "/api/tags", None))
    }

    fn loaded_models(&self) -> RuntimeFuture<'_, Result<Value, String>> {
        Box::pin(self.request_json_impl(Method::GET, "/api/ps", None))
    }

    fn warm_model(&self, model: String) -> RuntimeFuture<'_, Result<Value, String>> {
        Box::pin(self.request_json_impl(
            Method::POST,
            "/api/generate",
            Some(serde_json::json!({
                "model": model,
                "prompt": "",
                "stream": false,
                "keep_alive": OLLAMA_KEEP_ALIVE
            })),
        ))
    }

    fn chat_once(&self, body: Value) -> RuntimeFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            validate_chat_body(&body)?;
            self.request_json_impl(Method::POST, "/api/chat", Some(body))
                .await
        })
    }

    fn chat(&self, body: Value) -> RuntimeFuture<'_, Result<Response, String>> {
        Box::pin(async move {
            validate_chat_body(&body)?;
            let payload_bytes = serde_json::to_vec(&body)
                .map_err(|error| format!("序列化 Ollama 请求失败：{error}"))?;
            if payload_bytes.len() > MAX_JSON_REQUEST_BYTES {
                return Err(format!(
                    "Ollama 请求超过 {} MiB 限制",
                    MAX_JSON_REQUEST_BYTES / 1024 / 1024
                ));
            }
            self.client
                .post(format!("{OLLAMA_LOCAL_BASE_URL}/api/chat"))
                .json(&body)
                .send()
                .await
                .map_err(|error| error.to_string())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_chat_body, OllamaLocalAdapter, OLLAMA_KEEP_ALIVE, OLLAMA_LOCAL_BASE_URL};
    use crate::platform::contracts::{ChatMessage, ChatOptions, ChatRequest};
    use serde_json::json;
    use std::{
        env,
        io::{Read, Write},
        net::TcpListener,
        sync::{Mutex, OnceLock},
        thread,
        time::{Duration, Instant},
    };

    static PROXY_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct RestoreProxyEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl Drop for RestoreProxyEnvironment {
        fn drop(&mut self) {
            for (key, value) in self.0.drain(..) {
                if let Some(value) = value {
                    env::set_var(key, value);
                } else {
                    env::remove_var(key);
                }
            }
        }
    }

    #[test]
    fn local_adapter_keeps_the_loopback_boundary() {
        assert_eq!(OLLAMA_LOCAL_BASE_URL, "http://127.0.0.1:11434");
        assert_eq!(OLLAMA_KEEP_ALIVE, "30m");
        let _adapter = OllamaLocalAdapter::default();
    }

    #[tokio::test]
    async fn local_client_bypasses_proxies_and_does_not_follow_redirects() {
        let _env_lock = PROXY_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let proxy_keys = [
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ];
        let restore = RestoreProxyEnvironment(
            proxy_keys
                .iter()
                .map(|key| (*key, env::var_os(key)))
                .collect(),
        );

        let proxy = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        proxy.set_nonblocking(true).unwrap();
        let target = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        target.set_nonblocking(true).unwrap();
        let redirect = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        redirect.set_nonblocking(true).unwrap();

        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        for key in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            env::set_var(key, &proxy_url);
        }
        for key in ["NO_PROXY", "no_proxy"] {
            env::set_var(key, "");
        }

        let redirect_url = format!("http://{}/redirected", redirect.local_addr().unwrap());
        let target_addr = target.local_addr().unwrap();
        let target_response = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: {redirect_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let target_thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match target.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0; 1024];
                        let _ = stream.read(&mut request);
                        stream.write_all(target_response.as_bytes()).unwrap();
                        return true;
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return false,
                }
            }
        });

        let adapter = OllamaLocalAdapter::default();
        let request_url = format!("http://{target_addr}/chat");
        let response = tokio::time::timeout(
            Duration::from_secs(10),
            adapter
                .client
                .post(request_url)
                .body("private chat content")
                .send(),
        )
        .await;
        let target_received = target_thread.join().unwrap();
        let proxy_received = proxy.accept().is_ok();
        let redirect_received = redirect.accept().is_ok();
        drop(restore);

        assert!(response.is_ok(), "本机请求未能在时限内完成");
        let response = response.unwrap().expect("本机请求应返回 HTTP 响应");
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        assert!(target_received, "请求应直接到达本机目标");
        assert!(!proxy_received, "请求不应经过环境代理");
        assert!(!redirect_received, "客户端不应跟随重定向");
    }

    #[test]
    fn chat_body_rejects_unbounded_generation() {
        assert!(validate_chat_body(&json!({"options": {"num_predict": -1}})).is_err());
        assert!(validate_chat_body(&json!({"options": {"num_predict": 2048}})).is_ok());
        assert!(validate_chat_body(&json!({})).is_err());
    }

    #[test]
    fn chat_request_serializes_the_existing_ollama_payload() {
        let request = ChatRequest {
            model: "qwen3:4b-q4_K_M".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "你好".to_string(),
                thinking: None,
            }],
            stream: true,
            think: false,
            keep_alive: OLLAMA_KEEP_ALIVE,
            options: ChatOptions {
                num_ctx: 4096,
                num_predict: 2048,
                temperature: 0.7,
            },
        };
        assert_eq!(
            serde_json::to_value(request).expect("serialize chat request"),
            json!({
                "model": "qwen3:4b-q4_K_M",
                "messages": [{"role": "user", "content": "你好"}],
                "stream": true,
                "think": false,
                "keep_alive": "30m",
                "options": {"num_ctx": 4096, "num_predict": 2048, "temperature": 0.7}
            })
        );
    }
}
