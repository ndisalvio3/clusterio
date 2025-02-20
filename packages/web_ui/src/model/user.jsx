import React, { useEffect, useContext, useState } from "react";
import { Tag } from "antd";
import ControlContext from "../components/ControlContext";

import * as lib from "@clusterio/lib";

const { logger } = lib;

function calculateLastSeen(user, instanceId) {
	let stats;
	if (instanceId === undefined) {
		stats = user.playerStats;
	} else {
		stats = (user.instanceStats || new Map()).get(instanceId);
		if (!stats) {
			return undefined;
		}
	}
	if (stats.lastLeaveAt > stats.lastJoinAt) {
		return stats.lastLeaveAt;
	}
	if (stats.lastJoinAt) {
		return stats.lastLeaveAt;
	}
	return undefined;
}

export function formatLastSeen(user, instanceId = undefined) {
	if (user.instances.some(id => instanceId === undefined || id === instanceId)) {
		return <Tag color="green">Online</Tag>;
	}
	let lastSeen = calculateLastSeen(user, instanceId);
	if (lastSeen === undefined) {
		return undefined;
	}
	return new Date(lastSeen).toLocaleString();
}

export function sortLastSeen(userA, userB, instanceIdA = undefined, instanceIdB = undefined) {
	function epoch(user, instanceId) {
		return user.instances.some(id => instanceId === undefined || id === instanceId);
	}

	let epochA = epoch(userA, instanceIdA);
	let epochB = epoch(userB, instanceIdB);
	if (epochA !== epochB) {
		return epochA - epochB;
	}

	let lastSeenA = calculateLastSeen(userA, instanceIdA) || 0;
	let lastSeenB = calculateLastSeen(userB, instanceIdB) || 0;
	return lastSeenA - lastSeenB;
}

export function useUser(name) {
	let control = useContext(ControlContext);
	let [user, setUser] = useState({ loading: true });

	function updateUser() {
		control.send(new lib.UserGetRequest(name)).then(updatedUser => {
			setUser({ ...updatedUser, present: true });
		}).catch(err => {
			logger.error(`Failed to get user: ${err}`);
			setUser({ missing: true });
		});

	}

	useEffect(() => {
		if (typeof name !== "string") {
			setUser({ missing: true });
			return undefined;
		}
		updateUser();

		function updateHandler(newUser) {
			setUser({ ...newUser, present: true });
		}

		control.onUserUpdate(name, updateHandler);
		return () => {
			control.offUserUpdate(name, updateHandler);
		};
	}, [name]);

	return [user, updateUser];
}

export function useUserList() {
	let control = useContext(ControlContext);
	let [userList, setUserList] = useState([]);

	function updateUserList() {
		control.send(new lib.UserListRequest()).then(users => {
			setUserList(users);
		}).catch(err => {
			logger.error(`Failed to list users:\n${err}`);
		});
	}

	useEffect(() => {
		updateUserList();

		function updateHandler(newUser) {
			setUserList(oldList => {
				let newList = oldList.concat();
				let index = newList.findIndex(u => u.name === newUser.name);
				if (!newUser.isDeleted) {
					if (index !== -1) {
						newList[index] = newUser;
					} else {
						newList.push(newUser);
					}
				} else if (index !== -1) {
					newList.splice(index, 1);
				}
				return newList;
			});
		}

		control.onUserUpdate(null, updateHandler);
		return () => {
			control.offUserUpdate(null, updateHandler);
		};
	}, []);

	return [userList];
}
