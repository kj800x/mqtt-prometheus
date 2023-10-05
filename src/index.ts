import client from "prom-client";
import http from "http";
import mqtt from "mqtt";

const metricsServer = http.createServer((__req, res) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.writeHead(200);
  client.register.metrics().then((s) => {
    res.end(s);
  });
});

metricsServer.listen(8080, "0.0.0.0");

const mqttClient = mqtt.connect("mqtt://10.60.1.15:1883");
mqttClient.subscribe("#"); // All

const metrics: { [guageKey: string]: client.Gauge<"room"> } = {};
const currentMetrics: { [guageKey: string]: client.Gauge<"port"> } = {};
const lineMetrics: { [guageKey: string]: client.Gauge } = {};
const metricRooms: [string, string][] = [];
const currentMetricRooms: [string, string][] = [];
const lineMetricsList: string[] = [];
const lastUpdate: { [string: string]: number } = {};

function getMetric(name: string) {
  if (!(name in metrics)) {
    metrics[name] = new client.Gauge({
      name: name,
      help: name,
      labelNames: ["room"] as const,
    });
  }
  return metrics[name]!;
}

function getCurrentMetric(name: string) {
  if (!(name in currentMetrics)) {
    currentMetrics[name] = new client.Gauge({
      name: name,
      help: name,
      labelNames: ["port"] as const,
    });
  }
  return currentMetrics[name]!;
}

function getLineMetric(name: string) {
  if (!(name in lineMetrics)) {
    lineMetrics[name] = new client.Gauge({
      name: name,
      help: name,
    });
  }
  return lineMetrics[name]!;
}

function logMetric(name: string, room: string, value: number) {
  getMetric(`mqtt_${name}`).set({ room }, value);
  if (!metricRooms.some((entry) => entry[0] === name && entry[1] === room)) {
    metricRooms.push([name, room]);
  }
  lastUpdate[`mqtt_${name}_${room}`] = new Date().getTime();
}

function logCurrentMetric(name: string, port: string, value: number) {
  getCurrentMetric(`mqtt_energy_${name}`).set({ port }, value);
  if (
    !currentMetricRooms.some((entry) => entry[0] === name && entry[1] === port)
  ) {
    currentMetricRooms.push([name, port]);
  }
  lastUpdate[`mqtt_energy_${name}_${port}`] = new Date().getTime();
}

function logLineMetric(name: string, value: number) {
  getLineMetric(`mqtt_energy_${name}`).set(value);
  if (!lineMetricsList.some((entry) => entry === name)) {
    lineMetricsList.push(name);
  }
  lastUpdate[`mqtt_energy_${name}`] = new Date().getTime();
}

mqttClient.on("message", (topic, message) => {
  const topicParts = topic.split("/");
  if (topicParts[0] === "ESP32Env" && topicParts.length === 3) {
    const room = topicParts[1]!;
    const name = topicParts[2]!;
    logMetric(name, room, parseFloat(message.toString()));
  }

  if (
    topicParts[0] === "EnergyMonitor" &&
    topicParts[1]!.startsWith("port") &&
    topicParts[2] === "current"
  ) {
    const port = topicParts[1]!;
    const name = topicParts[2]!;
    logCurrentMetric(name, port, parseFloat(message.toString()));
  }

  if (
    (topicParts[0] === "EnergyMonitor" && topicParts[1] === "line_voltage") ||
    topicParts[1] === "line_frequency"
  ) {
    const name = topicParts[1]!;
    logLineMetric(name, parseFloat(message.toString()));
  }
});

// Remove a metric if we haven't seen an update in this amount of time
const WATCHDOG_INTERVAL = 30_000;

setInterval(() => {
  for (const entry of [...metricRooms]) {
    const name = entry[0];
    const room = entry[1];

    if (
      new Date().getTime() - lastUpdate[`mqtt_${name}_${room}`]! >
      WATCHDOG_INTERVAL
    ) {
      getMetric(`mqtt_${name}`).remove({ room });
      metricRooms.splice(metricRooms.indexOf(entry), 1);
      delete lastUpdate[`mqtt_${name}_${room}`];
    }
  }

  for (const entry of [...currentMetricRooms]) {
    const name = entry[0];
    const port = entry[1];

    if (
      new Date().getTime() - lastUpdate[`mqtt_energy_${name}_${port}`]! >
      WATCHDOG_INTERVAL
    ) {
      getCurrentMetric(`mqtt_energy_${name}`).remove({ port });
      currentMetricRooms.splice(currentMetricRooms.indexOf(entry), 1);
      delete lastUpdate[`mqtt_energy_${name}_${port}`];
    }
  }

  for (const name of [...lineMetricsList]) {
    if (
      new Date().getTime() - lastUpdate[`mqtt_energy_${name}`]! >
      WATCHDOG_INTERVAL
    ) {
      getCurrentMetric(`mqtt_energy_${name}`).remove();
      lineMetricsList.splice(lineMetricsList.indexOf(name), 1);
      delete lastUpdate[`mqtt_energy_${name}`];
    }
  }
}, WATCHDOG_INTERVAL);
