/**
 * 房间号前缀
 * @type {string}
 */
const ROOM_PREFIX = "srs_rtc_"
/**
 * 所有客户端加入的房间名称
 * @type {string}
 */
const CLIENTS_ROOM = "clients_room";
/**
 * 所有管理终端加入的房间名称
 * @type {string}
 */
const ADMINISTRATORS_ROOM = "administrators_room";

/**
 * 记录客户端当前会见房间及房间对应的Socket集合
 * @type {Map<string, Set<Socket>>}
 */
const clientRoomMap = new Map();
/**
 * 记录管理端当前会见房间及房间对应的Socket集合
 * @type {Map<string, Set<Socket>>}
 */
const administratorRoomMap = new Map();

/**
 * 通话状态
 */
const CALL_STATUS = {
    /**
     * 空闲状态
     *
     */
    IDLE: 1,
    /**
     * 拨号中状态
     */
    DIALING: 2,
    /**
     * 通话中状态
     */
    CALLING: 3
};


/**
 * 管理端请求事件
 * @type {{}}
 */
const ADMINISTRATORS_REQ_CMD = {};

/**
 * 管理员通知事件
 * @type {{}}
 */
const ADMINISTRATORS_NOTIFY_CMD = {
    /**
     * 通知管理员用户，有客户端上线
     */
    NOTIFY_CLIENT_ONLINE: "notify_client_online",
    /**
     * 通知管理员用户，有客户端下线
     */
    NOTIFY_CLIENT_OFFLINE: "notify_client_offline",
    /**
     * 单点登录：强制下线
     */
    NOTIFY_FORCED_OFFLINE: "notify_forced_offline",
};
/**
 * 客户端请求事件
 * @type {{}}
 */
const CLIENT_REQ_CMD = {
    /**
     * 邀请一个人 ——> 单聊
     */
    REQ_INVITE_SOMEONE: "req_invite_someone",
    /**
     * 邀请一些人 ——> 群聊
     */
    REQ_INVITE_SOME_PEOPLE: "req_invite_some_people",
    /**
     * 拒接通话
     */
    REQ_REJECT_CALL: "req_reject_call",
    /**
     * 接受通话
     */
    REQ_ACCEPT_CALL: "req_accept_call",
    /**
     * 请求推流
     */
    REQ_PUBLISH_STREAM: "req_publish_stream",
    /**
     * 挂断
     */
    REQ_HANG_UP: "req_hang_up"
};
/**
 * 客户端通知事件
 * @type {{}}
 */
const CLIENT_NOTIFY_CMD = {
    /**
     * 单点登录：强制下线
     */
    NOTIFY_FORCED_OFFLINE: "notify_forced_offline",
    /**
     * 通知请求通话
     */
    NOTIFY_REQUEST_CALL: "notify_request_call",
    /**
     * 通知拒接通话
     */
    NOTIFY_REJECT_CALL: "notify_reject_call",
    /**
     * 通知接受通话
     */
    NOTIFY_ACCEPT_CALL: "notify_accept_call",
    /**
     * 通知有人加入房间
     */
    NOTIFY_JOIN_ROOM: "notify_join_room",
    /**
     * 通知有人离开房间
     */
    NOTIFY_LEAVE_ROOM: "notify_leave_room",
    /**
     * 通知拉流
     */
    NOTIFY_PLAY_STREAM: "notify_play_stream"
};

const {Server} = require("socket.io");
const fs = require("fs");
const Express = require("express");
const app = new Express()

const {v4: uuidv4} = require('uuid');

//读取参数配置文件
const config = require('../config/config').parseConfig;
/**
 * 一个房间内最大客户端数量
 */
const MAX_CLIENTS_IN_ROOM = config.maxSizeOfRoom;

//ssl证书相关
const sslOptions = {
    key: fs.readFileSync(config.ssl.keyPath),
    cert: fs.readFileSync(config.ssl.pemPath)
};

const {
    USER_TYPE_CLIENT,
    USER_TYPE_ADMINISTRATOR,
    getUserInfo,
} = require('./user');

const {SuccessModel, ErrorModel} = require("../model/responseModel");

const socketIoConfig = config.socketIoConfig;

const httpServer = require('http').createServer(app);
const httpsServer = require('https').createServer(sslOptions, app);

const ioServer = new Server({
    cors: {
        credentials: false
    }
})

ioServer.attach(httpServer)
ioServer.attach(httpsServer)

/**
 * 连接前进行校验
 * @param socket
 * @param next
 * @param userType
 */
function socketAuthentication(socket, next, userType) {
    const query = socket.handshake.query;
    const userId = query.userId;
    if (!userId) {
        next(new Error("Missing param : [userId]."));
        return;
    }
    //查询用户信息
    getUserInfo(userId, userType).then(result => {
        if (result.length) {
            if (result.length === 1) {
                //保存用户信息
                socket.userInfo = result[0];
                //允许连接
                next();
            } else {
                //存在多条数据
                next(new Error(`userId: [${userId}] data.length: ${result.length}.`));
            }
        } else {
            //不存在数据
            next(new Error(`user info: userId[${userId}] doesn't exists.`));
        }
    }).catch(error => {
        console.error("socketAuthentication-database error:", error);
        //数据库连接失败
        next(new Error("failed to query the database."));
    });
}

/**
 * 连接地址
 * ws://ip:port/srs_rtc/signal/administrator?userId=xxx
 * wss://ip:port/srs_rtc/signal/administrator?userId=xxx
 * http://ip:port/srs_rtc/signal/administrator?userId=xxx
 * https://ip:port/srs_rtc/signal/administrator?userId=xxx
 */
const administratorNamespace = ioServer.of("/srs_rtc/signal/administrator")
    .use((socket, next) => {
        //校验管理员信息
        socketAuthentication(socket, next, USER_TYPE_ADMINISTRATOR)
    });

/**
 * 连接地址
 * ws://ip:port/srs_rtc/signal/client?userId=xxx
 * wss://ip:port/srs_rtc/signal/client?userId=xxx
 * http://ip:port/srs_rtc/signal/client?userId=xxx
 * https://ip:port/srs_rtc/signal/client?userId=xxx
 */
const clientNamespace = ioServer.of("/srs_rtc/signal/client")
    .use((socket, next) => {
        //校验客户端信息
        socketAuthentication(socket, next, USER_TYPE_CLIENT)
    });

//管理端连接
administratorNamespace.on("connection", function (socket) {
    //判断单点登记
    const singleSignOnSocket = getSocketByUserInfo(administratorNamespace, socket.userInfo);
    if (singleSignOnSocket) {
        //说明之前有同账号登录过
        //发送强制下线通知
        singleSignOnSocket.emit(ADMINISTRATORS_NOTIFY_CMD.NOTIFY_FORCED_OFFLINE);
        //强制断开socket
        singleSignOnSocket.disconnect(false);
    }
    setSocketCallStatus(socket, CALL_STATUS.IDLE)

    socket
        //发生错误时触发
        .on('error', (error) => {

        })
        //在客户端将要断开连接时触发（但尚未离开rooms）
        .on("disconnecting", (reason) => {

        })
        //断开连接时触发
        .on("disconnect", () => {

        });
});

//客户端连接
clientNamespace.on("connection", function (socket) {
    //判断单点登记
    const singleSignOnSocket = getSocketByUserInfo(clientNamespace, socket.userInfo);
    if (singleSignOnSocket) {
        //说明之前有同账号登录过
        //发送强制下线通知
        singleSignOnSocket.emit(CLIENT_NOTIFY_CMD.NOTIFY_FORCED_OFFLINE);
        //强制断开socket
        singleSignOnSocket.disconnect(false);
    }
    //通知管理终端有客户端上线
    administratorNamespace.emit(ADMINISTRATORS_NOTIFY_CMD.NOTIFY_CLIENT_ONLINE, socket.userInfo);

    setSocketCallStatus(socket, CALL_STATUS.IDLE)

    socket
        //邀请一个人
        .on(CLIENT_REQ_CMD.REQ_INVITE_SOMEONE, (userInfo, fn) => {
            //userInfo={userId:"123"}
            clientInviteSomeone(socket, userInfo, fn);
        })
        //邀请一些人
        .on(CLIENT_REQ_CMD.REQ_INVITE_SOME_PEOPLE, (list, fn) => {
            //list=[{userId:"123"}]
            clientInviteSomePeople(socket, list, fn);
        })
        //拒接
        .on(CLIENT_REQ_CMD.REQ_REJECT_CALL, (roomId, fn) => {

            clientRejectCall(socket, roomId, fn)
        })
        //同意通话
        .on(CLIENT_REQ_CMD.REQ_ACCEPT_CALL, (roomId, fn) => {
            if (!roomId) {
                fn(new ErrorModel(0, "roomId is null."));
                return
            }
            const success = clientJoinRoom(socket, roomId);
            if (success) {
                fn(new SuccessModel());
            } else {
                fn(new ErrorModel(0, "join room failed, exceeded maximum quantity limit."))
            }
        })
        .on(CLIENT_REQ_CMD.REQ_PUBLISH_STREAM, (list, fn) => {

        })
        .on(CLIENT_REQ_CMD.REQ_HANG_UP, (list, fn) => {

        })
        //发生错误时触发
        .on('error', (error) => {

        })
        //在客户端将要断开连接时触发（但尚未离开rooms）
        .on("disconnecting", (reason) => {

        })
        //断开连接时触发
        .on("disconnect", () => {

            //通知管理终端有客户端下线
            administratorNamespace.emit(ADMINISTRATORS_NOTIFY_CMD.NOTIFY_CLIENT_OFFLINE, socket.userInfo)
        });
});

/**
 * 根据用户信息获取socket
 */
function getSocketByUserInfo(namespace, userInfo) {
    for (const socket of namespace.sockets.values()) {
        let info = socket.userInfo;
        if (userInfo && info) {
            if (userInfo.userId === info.userId && userInfo.userType === info.userType) {
                return socket;
            }
        }
    }
    return undefined;
}

/**
 * 客户端邀请某人
 * @param inviteSocket
 * @param userInfo
 * @param fn
 */
function clientInviteSomeone(inviteSocket, userInfo, fn) {
    //先判断本身是否是空闲状态
    if (isSocketIdle(inviteSocket)) {
        //设置用户类型
        userInfo.userType = USER_TYPE_CLIENT;
        const inviteeClient = getSocketByUserInfo(clientNamespace, userInfo);
        if (inviteeClient) {
            if (isSocketIdle(inviteeClient)) {
                //先判断被邀请人是否在线，如果在线，判断是否是空闲状态
                const roomId = generateRoomId();

                const success = clientJoinRoom(inviteSocket, roomId)
                if (!success) {
                    //加入房间失败
                    fn(new ErrorModel(0, "join room failed, exceeded maximum quantity limit."))
                    return
                }
                //通知被邀请者，推送请求通话
                inviteeClient.emit(CLIENT_NOTIFY_CMD.NOTIFY_REQUEST_CALL, {
                    inviteInfo: inviteSocket.userInfo,
                    roomId: roomId
                });
                inviteeClient.callStatus = CALL_STATUS.CALLING;

                fn(new SuccessModel({inviteeInfo: inviteeClient.userInfo, roomId: roomId}))
            } else {
                //被邀请人忙碌
                fn(new ErrorModel(0, "the invitee is busy."))
            }
        } else {
            //被邀请人离线或不存在
            fn(new ErrorModel(0, "the invitee is offline or doesn't exist."))
        }
    } else {
        fn(new ErrorModel(0, "you are busy."))
    }
}

/**
 * 客户端邀请某人
 * @param inviteSocket
 * @param list
 * @param fn
 */
function clientInviteSomePeople(inviteSocket, list, fn) {
    //先判断本身是否是空闲状态
    if (isSocketIdle(inviteSocket)) {
        if (!list || list.length === 0) {
            fn(new ErrorModel(0, "invited list is empty."))
            return
        }
        const roomId = generateRoomId();

        //通话列表
        const callList = [];
        const callSocketList = [];
        //忙碌列表
        const busyList = [];
        //离线或不存在列表
        const offlineOrNotExists = [];

        for (const userInfo of list) {
            //超出房间最大socket数量
            if (callSocketList.length >= MAX_CLIENTS_IN_ROOM) {
                break
            }
            //设置用户类型
            userInfo.userType = USER_TYPE_CLIENT;
            const inviteeClient = getSocketByUserInfo(clientNamespace, userInfo);
            if (inviteeClient) {
                if (isSocketIdle(inviteeClient)) {
                    callList.push(inviteeClient.userInfo);
                    callSocketList.push(inviteeClient);
                } else {
                    busyList.push(inviteeClient.userInfo);
                }
            } else {
                delete userInfo.userType
                offlineOrNotExists.push(userInfo)
            }
        }
        //判断可通话列表是否为空，如果为空，则没有通话意义。
        if (callSocketList.length !== 0) {
            const success = clientJoinRoom(inviteSocket, roomId)
            if (!success) {
                //加入房间失败
                fn(new ErrorModel(0, "join room failed, exceeded maximum quantity limit."))
                return;
            }

            const inviteeData = {inviteInfo: inviteSocket.userInfo, callList: callList, roomId: roomId};
            callSocketList.forEach(socket => {
                //通知被邀请者，推送请求通话
                socket.emit(CLIENT_NOTIFY_CMD.NOTIFY_REQUEST_CALL, inviteeData);
                setSocketCallStatus(socket, CALL_STATUS.CALLING);
            });

            const data = {
                callList: callList,
                busyList: busyList,
                offlineOrNotExists: offlineOrNotExists,
                roomId: roomId
            };
            fn(new SuccessModel(data));
        } else {
            //无意义的通话
            fn(new ErrorModel(0, "status of all invitees is busy, offline or absent."))
        }
    } else {
        //被邀请人忙碌
        fn(new ErrorModel(0, "the invitee is busy."))
    }
}

/**
 * 客户端加入房间
 * @param socket
 * @param roomId
 * @returns {boolean} true：加入成功，false：加入失败
 */
function clientJoinRoom(socket, roomId) {
    if (canRoomAddSocket(clientRoomMap, roomId)) {
        socket.join(roomId);
        setSocketCallStatus(socket, CALL_STATUS.DIALING);
        socket.currentCallRoom = roomId;

        //将会见信息保存在本地
        const sockets = getRoomSockets(clientRoomMap, roomId, true)
        sockets.add(socket);

        const info = {userInfo: socket.userInfo, roomId: roomId};
        //像房间内其他人发送进入房间消息
        socket.to(roomId).emit(CLIENT_NOTIFY_CMD.NOTIFY_JOIN_ROOM, info);
        return true;
    }
    return false;
}

/**
 * 客户端离开房间
 * @param socket
 * @param roomId
 */
function clientLeaveRoom(socket, roomId) {
    const sockets = getRoomSockets(clientRoomMap, roomId, false);

    //当前socket是否在房间内
    const selfInRoom = isSocketInRoom(socket, roomId);
    if (selfInRoom) {
        if (sockets) {
            if (sockets.size <= 2) {

            }
        }
    } else {

    }
    if (sockets.size) {

    } else {

    }
    socket.leave(roomId);
}

/**
 * 客户端拒接
 * @param socket
 * @param roomId
 * @param fn
 */
function clientRejectCall(socket, roomId, fn) {
    if (!roomId) {
        fn(new ErrorModel(0, "roomId is null."));
        return
    }
    const sockets = getRoomSockets(clientRoomMap, roomId, false);
    //当前socket是否在房间内
    const selfInRoom = isSocketInRoom(socket, roomId);
    if (selfInRoom) {
        fn(new ErrorModel(0, "clientRejectCall failed: selfInRoom."));
        return;
    }
    if (!sockets || sockets.size === 0) {
        return;
    }
    //数量为1
    if (sockets.size === 1) {
        const socket = sockets[0];
        socket.leave(roomId);
        clientRoomMap.delete(roomId);

    } else {

    }
}

/**
 * 判断客户端是否在指定房间内
 * @param socket
 * @param roomId
 * @returns {boolean}
 */
const isSocketInRoom = (socket, roomId) => {
    return socket.rooms.contains(roomId);
}

/**
 * 生成会见房间号
 * @returns {string}
 */
const generateRoomId = () => {
    return `${ROOM_PREFIX}${uuidv4()}`
}
/**
 * 判断socket是否处于空闲状态
 * @param socket
 */
const isSocketIdle = (socket) => {
    return socket.callStatus === CALL_STATUS.IDLE;
}

/**
 * 设置socket状态
 * @param socket
 * @param status
 */
const setSocketCallStatus = (socket, status) => {
    if (status === CALL_STATUS.IDLE) {
        socket.currentCallRoom = undefined;
    }
    socket.callStatus = status;
}

/**
 * 判断房间是否可以继续添加socket
 * @param roomMap
 * @param roomId
 * @returns {boolean}
 */
const canRoomAddSocket = (roomMap, roomId) => {
    const sockets = getRoomSockets(roomMap, roomId, false)
    return !sockets || sockets.size < MAX_CLIENTS_IN_ROOM;
}

/**
 *
 * @param roomMap
 * @param roomId
 * @param autoCreate 查不到时是否自动创建，true：自动创建，false：不创建
 * @returns {Set<Socket>}
 */
const getRoomSockets = (roomMap, roomId, autoCreate) => {
    let sockets = roomMap.get(roomId);
    if (autoCreate && !sockets) {
        sockets = new Set();
        roomMap.set(roomId, sockets);
    }
    return sockets;
}


/**
 * 启动api服务
 */
function startSignalServer() {
    httpServer.listen(socketIoConfig.httpPort, function () {
        console.log("SignalHttpServer listen: " + socketIoConfig.httpPort);
    });
    httpsServer.listen(socketIoConfig.httpsPort, function () {
        console.log("SignalHttpsServer listen: " + socketIoConfig.httpsPort);
    });
}

module.exports = {
    startSignalServer
}
