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
const waterMetrics: { [guageKey: string]: client.Gauge } = {};
const metricRooms: [string, string][] = [];
const currentMetricRooms: [string, string][] = [];
const lineMetricsList: string[] = [];
const waterMetricsList: string[] = [];
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

function getWaterMetric(name: string) {
  if (!(name in waterMetrics)) {
    waterMetrics[name] = new client.Gauge({
      name: name,
      help: name,
    });
  }
  return waterMetrics[name]!;
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

function logWaterMetric(name: string, value: number) {
  getWaterMetric(`mqtt_water_${name}`).set(value);
  if (!waterMetricsList.some((entry) => entry === name)) {
    waterMetricsList.push(name);
  }
  lastUpdate[`mqtt_water_${name}`] = new Date().getTime();
}

interface LinkTapUpdate {
  dev_id: string;
  plan_mode: number;
  plan_sn: number;
  is_rf_linked: "ON" | "OFF";
  is_flm_plugin: "ON" | "OFF";
  is_fall: "ON" | "OFF";
  is_broken: "ON" | "OFF";
  is_cutoff: "ON" | "OFF";
  is_leak: "ON" | "OFF";
  is_clog: "ON" | "OFF";
  signal: number; // 0-100 naturals
  battery: number; // 0-100 naturals
  child_lock: number; // probably just 0 or 1?
  is_manual_mode: "ON" | "OFF";
  is_watering: "ON" | "OFF";
  is_final: "ON" | "OFF";
  total_duration: number; // in natural seconds
  remain_duration: number; // in natural seconds;
  speed: number; // in float gal/min
  volume: number; // in float gal since last "is_watering" = "ON" (I THINK)
  volume_limit: number; // not sure, just 0 in testing
  failsafe_duration: number; // not sure, just 0 in testing
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

  if (
    topicParts[0] === "homeassistant" &&
    topicParts[1] === "linktap" &&
    !topicParts[2]!.includes("_") &&
    topicParts[3] === "state"
  ) {
    const parsed: LinkTapUpdate = JSON.parse(message.toString());
    logWaterMetric("flow_in_gpm", parsed.speed);
    logWaterMetric("battery_in_whole_percent", parsed.battery);
    logWaterMetric("signal_in_whole_percent", parsed.signal);
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

  for (const name of [...waterMetricsList]) {
    if (
      new Date().getTime() - lastUpdate[`mqtt_water_${name}`]! >
      WATCHDOG_INTERVAL
    ) {
      getWaterMetric(`mqtt_water_${name}`).remove();
      waterMetricsList.splice(waterMetricsList.indexOf(name), 1);
      delete lastUpdate[`mqtt_water_${name}`];
    }
  }
}, WATCHDOG_INTERVAL);
