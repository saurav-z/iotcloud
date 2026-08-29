#include <WiFiNINA.h>
#include <ArduinoHttpClient.h>

char ssid[] = "YOUR_WIFI";
char pass[] = "YOUR_PASSWORD";
char host[] = "YOUR_HOST";
WiFiSSLClient wifi;
HttpClient client = HttpClient(wifi, host, 443);

void setup() {
  Serial.begin(115200);
  while (WiFi.begin(ssid, pass) != WL_CONNECTED) delay(1000);
}

void loop() {
  client.beginRequest();
  client.post("/api/device/publish");
  client.sendHeader("Authorization", "Bearer DEVICE_TOKEN");
  client.sendHeader("Content-Type", "application/json");
  client.sendHeader("Content-Length", 94);
  client.beginBody();
  client.print("{\"deviceId\":\"DEVICE_ID\",\"topic\":\"telemetry\",\"data\":{\"temperature\":28.4}}");
  client.endRequest();
  Serial.println(client.responseStatusCode());
  delay(5000);
}
