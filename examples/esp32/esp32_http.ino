#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASSWORD = "YOUR_PASSWORD";
const char* API = "https://YOUR_HOST";
const char* DEVICE_TOKEN = "DEVICE_TOKEN";
const char* DEVICE_ID = "DEVICE_ID";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(300);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(String(API) + "/api/device/publish");
    http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
    http.addHeader("Content-Type", "application/json");
    String body = String("{\"deviceId\":\"") + DEVICE_ID + "\",\"topic\":\"telemetry\",\"data\":{\"temperature\":28.4}}";
    Serial.println(http.POST(body));
    http.end();
  }
  delay(5000);
}
