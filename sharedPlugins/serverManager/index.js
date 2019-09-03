const needle = require("needle");
const fs = require("fs-extra");

const pluginConfig = require("./config");

module.exports = class remoteCommands {
	constructor(mergedConfig, messageInterface, extras){
		this.messageInterface = messageInterface;
		this.config = mergedConfig;
		this.socket = extras.socket;
		const pluginManager = require("lib/manager/pluginManager");
		// const modManager = require("lib/manager/modManager");
		this.socket.on("hello", () => {
			this.socket.emit("registerServerManager");
		});
		this.socket.on("serverManagerGetStatus", async data => {
			
		});
		this.socket.on("serverManagerGetMods", async (data, callback) => {
			// TODO: Implement this function separately from listMods (which console.logs it)
			// let mods = modManager.getMods(this.config)
			// callback(mods);
		});
		this.socket.on("serverManagerGetPlugins", async (data, callback) => {
			callback(await pluginManager.getPlugins());
		});
		this.socket.on("serverManagerEnablePlugin", async (data, callback) => {
			callback(await pluginManager.enablePlugin(data.name, data.instanceID /* Currently ignored */));
		});
		this.socket.on("serverManagerDisablePlugin", async (data, callback) => {
			callback(await pluginManager.disablePlugin(data.name, data.instanceID /* Currently ignored */));
		});
	}
}
