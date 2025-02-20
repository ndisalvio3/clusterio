"use strict";
const { BaseControlPlugin, CommandTree, Command } = require("@clusterio/lib");
const { ChatEvent } = require("./messages");


const globalChatCommands = new CommandTree({
	name: "global-chat", description: "Global Chat plugin commands",
});
globalChatCommands.add(new Command({
	definition: ["shout <message>", "Send message to all instances", (yargs) => {
		yargs.positional("message", { describe: "message to send", type: "string" });
	}],
	handler: async function(args, control) {
		await control.sendTo("allInstances", new ChatEvent("Console", args.message));
	},
}));

class ControlPlugin extends BaseControlPlugin {
	async addCommands(rootCommand) {
		rootCommand.add(globalChatCommands);
	}
}

module.exports = {
	ControlPlugin,
};
