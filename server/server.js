const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const firebaseService = require('./services/firebase.js');

class TCPServer {
    constructor() {
        this.server = null;
        this.initializeServer();
    }

    start(port) {
        this.server.listen(port, () => {
            console.log(`Server is running on port ${port}`);
        });

    }

    initializeServer() {
        this.app = express();
        this.server = http.createServer(this.app);

        // Lưu lại 1 Map các id user và Socket của họ để khi server gửi lại thì sẽ biết dùng gửi đến client bằng socket nào
        this.users = new Map();

        // Lưu thông tin 
        this.socketDataMap = new Map();
        this.io = socketIO(this.server, {
            cors: {
                origin: 'http://localhost:4200',
                methods: ['GET', 'POST'],
            },
            maxHttpBufferSize: 1e8, // 100MB
            maxWebsocketFrameSize: 1e8, // 100MB
        });

        // Sử dụng middleware cors
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', 'http://localhost:4200');
            res.header('Access-Control-Allow-Methods', 'GET, POST');
            res.header('Access-Control-Allow-Headers', 'Content-Type');
            next();
        });


        this.io.on('connection', (socket) => {
            this.socketDataMap.set(socket.id, {});
            let currentUserId = '';

            // Dùng 1 mảng lưu lại các ảnh mà user này đã upload, mục đích lưu cả danh sách này vào 1 collection trong 1 message mới
            let uploadDataFiles = [];
            let audioChunksMap = new Map();

            console.log('Client đã kết nối');

            socket.on('login', (data) => {
                console.log(data.userId, socket.id);
                currentUserId = data.userId;
                this.users.set(data.userId, socket);
            });

            socket.on('text', (data) => {
                console.log('Text: ', data);
                firebaseService.saveMessageIntoDB(data.chatId, currentUserId, data.text, data.type);
            });

            socket.on('addToGroupChat', (data) => {
                console.log('Add to group chat: ', data);
                this.addToGroupChat(currentUserId, data.newUserIds, data.chatId);
            });

            socket.on('audio', (data) => {
                console.log('audio: ', data);
                this.combineChunksOfAudio(data, audioChunksMap);
            })

            socket.on('dataFiles', (data) => {
                console.log('dataFiles: ', data);
                this.combineChunksOfDataFiles(socket, data, uploadDataFiles, data.type);
            })

            socket.on('disconnect', () => {
                console.log('Client đã ngắt kết nối');
                this.users.delete(currentUserId);
            });
        });
    }

    /**
     * Tiến hành gộp các đoạn của ảnh đã được gửi từ client
     * @param socket: socket của user đang kết nối 
     * @param data:  id, chunkIndex, chunk, totalChunk
     */
    combineChunksOfDataFiles(socket, data, uploadDataFiles, type) {
        const socketData = this.socketDataMap.get(socket.id);
        if (!socketData[data.dataFileId]) {
            socketData[data.dataFileId] = {};
        }
        socketData[data.dataFileId][data.chunkIndex] = data.chunk;

        const totalChunks = data.totalChunks;
        const receivedChunks = Object.keys(socketData[data.dataFileId]).length;
        if (totalChunks == receivedChunks) {
            // Khi đã nhận đã số chunk đã chia nhỏ của file thì tiến hành gộp lại
            const completeBase64Data = Object.values(socketData[data.dataFileId]).join('');
            delete socketData[data.dataFileId];
            this.saveDataFilesIntoDB(data.fromUser, data.chatId, data.dataFileId, data.fileName, completeBase64Data, uploadDataFiles, data.dataFilesCount, type)
            console.log(`Da gui file ${data.fileName}`);
        }
    }

    combineChunksOfAudio(data, audioChunksMap) {
        const { fromUser, chatId, chunkIndex, chunk, totalChunks } = data;
        if (!audioChunksMap.has(chatId)) {
            audioChunksMap.set(chatId, new Array(totalChunks).fill(null));
        }
        const chunksArray = audioChunksMap.get(chatId);
        chunksArray[chunkIndex] = chunk;
        const hasAllChunks = chunksArray.every((chunk) => chunk !== null);
        if (hasAllChunks) {
            const audioBuffer = Buffer.concat(chunksArray.map((chunk) => Buffer.from(chunk)));
            this.saveAudioIntoDB(fromUser, chatId, audioBuffer)
            audioChunksMap.delete(chatId);
        }
    }

    saveAudioIntoDB(fromUserId, chatId, bufferData) {
        const fileNameInFirebase = `${new Date().getTime()}_${chatId}.ogg`;
        firebaseService.saveBufferToAudioFolder(bufferData, fileNameInFirebase)
            .then((audioURL) => {
                firebaseService.saveAudioIntoDB(chatId, fromUserId, audioURL);
            });
    }

    saveDataFilesIntoDB(fromUserId, chatId, dataFileId, fileName, base64Data, uploadDataFiles, dataFilesCount, type) {
        const fileNameInFirebase = `${new Date().getTime()}_${chatId}_${dataFileId}_${fileName}`;
        firebaseService.saveBase64ToImageFolder(base64Data, fileNameInFirebase, type)
            .then((fileURL) => {
                uploadDataFiles.push({ fileURL, fileName });
                if (uploadDataFiles.length === dataFilesCount) {
                    firebaseService.saveDataFilesIntoDB(chatId, fromUserId, uploadDataFiles, type).then(() => {
                        uploadDataFiles.splice(0, uploadDataFiles.length);
                    });
                }
            });
    }

    sendDataToChatRoom(chatId, uploadImages) {
        firebaseService.getUsersInChatRoom(chatId)
            .then((userIds) => {
                console.log('Nội dung gửi: ', uploadImages);
                userIds.forEach((userId) => {
                    const socket = this.users.get(userId);
                    // socket.emit('images', uploadImages);
                });

                // Xoá danh sách ảnh đã upload ngay sau khi gửi xong để sẵn sàng nhận cho
                uploadImages.splice(0, uploadImages.length);
            });
    }

    addToGroupChat(currentUserId, newUserIds, chatId) {
        const socket = this.users.get(currentUserId);
        socket.emit('addToGroupChat', { newUserIds: newUserIds, chatId: chatId });
    }

}

module.exports = TCPServer;