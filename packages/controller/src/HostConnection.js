"use strict";
const lib = require("@clusterio/lib");
const { logger, PlayerStats } = lib;

const BaseConnection = require("./BaseConnection");
const InstanceInfo = require("./InstanceInfo");


/**
 * Represents the connection to a host
 *
 * @extends module:controller/src/BaseConnection
 * @alias module:controller/src/HostConnection
 */
class HostConnection extends BaseConnection {
	constructor(registerData, connector, controller) {
		super(connector, controller);

		this._agent = registerData.agent;
		this._id = registerData.id;
		this._name = registerData.name;
		this._version = registerData.version;
		this.plugins = new Map(Object.entries(registerData.plugins));
		this._checkPluginVersions();

		this._controller.hosts.set(this._id, {
			agent: this._agent,
			id: this._id,
			name: this._name,
			version: this._version,
			public_address: registerData.publicAddress,
			plugins: registerData.plugins,
		});

		for (let event of ["connect", "drop", "resume", "close"]) {
			// eslint-disable-next-line no-loop-func
			this.connector.on(event, () => {
				for (let plugin of this._controller.plugins.values()) {
					plugin.onHostConnectionEvent(this, event);
				}
			});
		}

		this.connector.on("close", () => {
			// Update status to unknown for instances on this host.
			for (let instance of this._controller.instances.values()) {
				if (instance.config.get("instance.assigned_host") !== this._id) {
					continue;
				}

				let prev = instance.status;
				instance.status = "unknown";
				this._controller.instanceUpdated(instance);
				lib.invokeHook(this._controller.plugins, "onInstanceStatusChanged", instance, prev);
			}
		});

		this.handle(lib.InstanceStatusChangedEvent, this.handleInstanceStatusChangedEvent.bind(this));
		this.handle(lib.InstancesUpdateRequest, this.handleInstancesUpdateRequest.bind(this));
		this.handle(lib.InstanceSaveListUpdateEvent, this.handleInstanceSaveListUpdateEvent.bind(this));
		this.handle(lib.LogMessageEvent, this.handleLogMessageEvent.bind(this));
		this.handle(lib.InstancePlayerUpdateEvent, this.handleInstancePlayerUpdateEvent.bind(this));
	}

	validateIngress(message) {
		let origin = this.connector.dst;
		switch (message.src.type) {
			case lib.Address.control:
			case lib.Address.controller:
				throw new lib.InvalidMessage(`Received message with invalid src ${message.src} from ${origin}`);

			case lib.Address.host:
				if (message.src.id !== origin.id) {
					throw new lib.InvalidMessage(
						`Received message with invalid src ${message.src} from ${origin}`
					);
				}
				break;

			case lib.Address.instance:
				let instance = this._controller.instances.get(message.src.id);
				if (!instance || instance.config.get("instance.assigned_host") !== this._id) {
					throw new lib.InvalidMessage(
						`Received message with invalid src ${message.src} from ${origin}`
					);
				}
				break;

			default:
				throw new Error("Should be unreachable");
		}
	}

	_checkPluginVersions() {
		let pluginInfos = new Map(this._controller.pluginInfos.map(i => [i.name, i]));
		for (let [name, version] of this.plugins) {
			let info = pluginInfos.get(name);
			if (!info) {
				logger.warn(`Host ${this._name} has plugin ${name} ${version} which the controller does not have`);
				continue;
			}

			if (info.version !== version) {
				logger.warn(
					`Host ${this._name} has plugin ${name} ${version} which does not match the version of this ` +
					`plugin on the controller (${info.version})`
				);
			}
		}

		for (let [name, info] of pluginInfos) {
			if (!this.plugins.has(name)) {
				logger.warn(`Host ${this._name} is missing plugin ${name} ${info.version}`);
			}
		}
	}

	async prepareDisconnect() {
		await lib.invokeHook(this._controller.plugins, "onPrepareHostDisconnect", this);
		return await super.prepareDisconnect();
	}

	/**
	 * ID of the host this connection is connected to
	 *
	 * @returns {number} host ID.
	 */
	get id() {
		return this._id;
	}

	async handleInstanceStatusChangedEvent(request) {
		let instance = this._controller.instances.get(request.instanceId);

		// It's possible to get updates from an instance that does not exist
		// or is not assigned to the host it originated from if it was
		// reassigned or deleted while the connection to the host it was
		// originally on was down at the time.
		if (!instance || instance.config.get("instance.assigned_host") !== this._id) {
			logger.warn(`Got bogus update for instance id ${request.instanceId}`);
			return;
		}

		// We may receive status changed where the status hasn't changed
		// from our perspective if the connection was down at the time it
		// changed.  Hosts also send status updates on assignInstance which
		// for hacky reason is also used to push config changes and
		// restablish status after a connection loss.
		if (instance.status === request.status) {
			return;
		}

		let prev = instance.status;
		instance.status = request.status;
		instance.game_port = request.gamePort;
		logger.verbose(`Instance ${instance.config.get("instance.name")} State: ${instance.status}`);
		this._controller.instanceUpdated(instance);
		await lib.invokeHook(this._controller.plugins, "onInstanceStatusChanged", instance, prev);
	}

	async handleInstancesUpdateRequest(request) {
		// Push updated instance configs
		for (let instance of this._controller.instances.values()) {
			if (instance.config.get("instance.assigned_host") === this._id) {
				await this.send(
					new lib.InstanceAssignInternalRequest(instance.id, instance.config.serialize("host"))
				);
			}
		}

		// Assign instances the host has but controller does not
		for (let instanceData of request.instances) {
			let instanceConfig = new lib.InstanceConfig("controller");
			await instanceConfig.load(instanceData.config, "host");

			let controllerInstance = this._controller.instances.get(instanceConfig.get("instance.id"));
			if (controllerInstance) {
				// Check if this instance is assigned somewhere else.
				if (controllerInstance.config.get("instance.assigned_host") !== this._id) {
					await this.send(
						new lib.InstanceUnassignInternalRequest(instanceConfig.get("instance.id"))
					);
					continue;
				}

				// Already have this instance, update state instead
				if (controllerInstance.status !== instanceData.status) {
					let prev = controllerInstance.status;
					controllerInstance.status = instanceData.status;
					logger.verbose(`Instance ${instanceConfig.get("instance.name")} State: ${instanceData.status}`);
					this._controller.instanceUpdated(controllerInstance);
					await lib.invokeHook(
						this._controller.plugins, "onInstanceStatusChanged", controllerInstance, prev
					);
				}
				continue;
			}

			instanceConfig.set("instance.assigned_host", this._id);
			let newInstance = new InstanceInfo({ config: instanceConfig, status: instanceData.status });
			this._controller.instances.set(instanceConfig.get("instance.id"), newInstance);
			this._controller.addInstanceHooks(newInstance);
			await this.send(
				new lib.InstanceAssignInternalRequest(
					instanceConfig.get("instance.id"), instanceConfig.serialize("host")
				)
			);
			await lib.invokeHook(this._controller.plugins, "onInstanceStatusChanged", newInstance, null);
		}

		// Push lists to make sure they are in sync.
		let adminlist = [];
		let banlist = [];
		let whitelist = [];

		for (let user of this._controller.userManager.users.values()) {
			if (user.isAdmin) {
				adminlist.push(user.name);
			}
			if (user.isBanned) {
				banlist.push([user.name, user.banReason]);
			}
			if (user.isWhitelisted) {
				whitelist.push(user.name);
			}
		}

		await this.send(new lib.SyncUserListsEvent(adminlist, banlist, whitelist));
	}

	async handleInstanceSaveListUpdateEvent(event) {
		this._controller.saveListUpdate(event.instanceId, event.saves);
	}

	async handleLogMessageEvent(event) {
		this._controller.clusterLogger.log({
			...event.info,
			host_id: this._id,
			host_name: this._name,
		});
	}

	async handleInstancePlayerUpdateEvent(event, src) {
		let instanceId = src.id;
		let user = this._controller.userManager.users.get(event.name);
		if (!user) {
			user = this._controller.userManager.createUser(event.name);
		}

		if (event.type === "join") {
			user.notifyJoin(instanceId);
		} else if (event.type === "leave") {
			user.notifyLeave(instanceId);
		}
		user.instanceStats.set(instanceId, new PlayerStats(event.stats));
		user.recalculatePlayerStats();
		this._controller.userUpdated(user);

		let instance = this._controller.instances.get(instanceId);
		await lib.invokeHook(this._controller.plugins, "onPlayerEvent", instance, {
			type: event.type,
			name: event.name,
			reason: event.reason,
		});
	}
}

module.exports = HostConnection;
