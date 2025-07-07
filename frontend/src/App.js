import React, { useState, useEffect, useRef, useCallback } from 'react';

// Base URL for your backend API.
const API_BASE_URL = 'localhost:3001';

function App() {
    // --- Existing State ---
    const [user, setUser] = useState(null);
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [uploadingFile, setUploadingFile] = useState(null);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadError, setUploadError] = useState(null);
    const [showAdminPanel, setShowAdminPanel] = useState(false);
    const [allUsers, setAllUsers] = useState([]);
    const [loginUsername, setLoginUsername] = useState('');
    const [loginPassword, setLoginPassword] = useState('');
    const [isRegistering, setIsRegistering] = useState(false);
    const [authError, setAuthError] = useState('');
    const [channels, setChannels] = useState([]);
    const [activeChannelId, setActiveChannelId] = useState(null);
    const [showProfileModal, setShowProfileModal] = useState(false);
    const [newDisplayName, setNewDisplayName] = useState('');
    const [newProfilePhoto, setNewProfilePhoto] = useState(null);
    const [profileUpdateError, setProfileUpdateError] = useState('');
    const [newChannelName, setNewChannelName] = useState('');
    const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
    const [createChannelError, setCreateChannelError] = useState('');
    const [messagesLimit] = useState(20);
    const [hasMoreMessages, setHasMoreMessages] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isChannelLoading, setIsChannelLoading] = useState(false);

    // --- Voice Channel State ---
    const [voiceChannelActive, setVoiceChannelActive] = useState(false);
    const [voicePeers, setVoicePeers] = useState([]); 

    // --- Refs ---
    const lastFetchedMessageIdRef = useRef(null);
    const messagesEndRef = useRef(null);
    const messagesStartRef = useRef(null);
    const messageContainerRef = useRef(null);
    const wsRef = useRef(null);
    const localStreamRef = useRef(null);
    const myClientIdRef = useRef(null);

    // --- API Helper Function ---
    const authenticatedFetch = useCallback(async (url, options = {}) => {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };
        if (user && user.token) {
            headers['Authorization'] = `Bearer ${user.token}`;
        }
        const response = await fetch(`${API_BASE_URL}${url}`, { ...options, headers });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'An unknown error occurred.' }));
            throw new Error(errorData.message || 'API request failed');
        }
        return response.json();
    }, [user]);

    // --- Authentication Check on Load ---
    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        const storedUser = localStorage.getItem('user');
        if (storedToken && storedUser) {
            try {
                const parsedUser = JSON.parse(storedUser);
                setUser({ ...parsedUser, token: storedToken });
            } catch (e) {
                console.error("Failed to parse stored user data:", e);
                localStorage.removeItem('token');
                localStorage.removeItem('user');
            }
        }
    }, []);

    // --- Fetch Channels on Login/User Change ---
    const fetchChannels = useCallback(async () => {
        if (!user || !user.token) return;
        try {
            const data = await authenticatedFetch('/api/channels');
            setChannels(data);
            if (data.length > 0 && !activeChannelId) {
                setActiveChannelId(data[0].id);
            }
        } catch (error) {
            console.error('Error fetching channels:', error);
            setAuthError(error.message);
        }
    }, [user, authenticatedFetch, activeChannelId]);

    useEffect(() => {
        fetchChannels();
    }, [fetchChannels]);

    // --- Fetch Messages for Active Channel ---
    const fetchMessages = useCallback(async (loadMore = false, initialLoad = false) => {
        if (!user || !user.token || !activeChannelId) {
            setMessages([]);
            setHasMoreMessages(false);
            lastFetchedMessageIdRef.current = null;
            return;
        }
        if (loadMore && isLoadingMore) return;

        const messageContainer = messageContainerRef.current;
        const isNearBottom = messageContainer
            ? messageContainer.scrollHeight - messageContainer.scrollTop <= messageContainer.clientHeight + 150
            : true;

        setIsLoadingMore(loadMore);

        let url = `/api/messages/${activeChannelId}?limit=${messagesLimit}`;
        if (loadMore) {
            setMessages(prevMessages => {
                const oldestMessageId = prevMessages[0]?.id;
                if (oldestMessageId) {
                    url += `&beforeId=${oldestMessageId}`;
                }
                return prevMessages;
            });
        } else if (!loadMore && lastFetchedMessageIdRef.current) {
            url += `&sinceId=${lastFetchedMessageIdRef.current}`;
        }

        try {
            const data = await authenticatedFetch(url);
            if (data && Array.isArray(data.messages)) {
                const newMessages = data.messages;
                const moreAvailable = data.hasMore;

                if (loadMore) {
                    const oldScrollHeight = messageContainer?.scrollHeight || 0;
                    setMessages(prevMessages => [...newMessages, ...prevMessages]);
                    requestAnimationFrame(() => {
                        if (messageContainer) {
                            const newScrollHeight = messageContainer.scrollHeight;
                            messageContainer.scrollTop = newScrollHeight - oldScrollHeight;
                        }
                    });
                } else {
                    if (initialLoad) {
                        setMessages(newMessages);
                        if (newMessages.length > 0) {
                            lastFetchedMessageIdRef.current = newMessages[newMessages.length - 1].id;
                        } else {
                            lastFetchedMessageIdRef.current = null;
                        }
                        setTimeout(() => messagesEndRef.current?.scrollIntoView(), 100);
                    } else if (newMessages.length > 0) {
                        setMessages(prevMessages => {
                            const uniqueNewMessages = newMessages.filter(nm => !prevMessages.some(pm => pm.id === nm.id));
                            return [...prevMessages, ...uniqueNewMessages].sort((a, b) => a.id - b.id);
                        });
                        lastFetchedMessageIdRef.current = newMessages[newMessages.length - 1].id;
                        if (isNearBottom) {
                            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                        }
                    }
                }
                setHasMoreMessages(moreAvailable);
            } else {
                setMessages([]);
                setHasMoreMessages(false);
            }
        } catch (error) {
            console.error('Error fetching messages:', error);
        } finally {
            setIsLoadingMore(false);
        }
    }, [user, activeChannelId, authenticatedFetch, messagesLimit, isLoadingMore]);

    // --- Message Polling and Initial Load ---
    useEffect(() => {
        const loadInitialMessages = async () => {
            if (user && activeChannelId) {
                setIsChannelLoading(true);
                setHasMoreMessages(true);
                lastFetchedMessageIdRef.current = null;
                await fetchMessages(false, true);
                setIsChannelLoading(false);
            } else {
                setMessages([]);
            }
        };
        loadInitialMessages();
        const intervalId = setInterval(() => {
            if (!isChannelLoading) {
                fetchMessages(false);
            }
        }, 5000);
        return () => clearInterval(intervalId);
    }, [user, activeChannelId, fetchMessages]);

    // --- Voice Channel Core Logic ---
    useEffect(() => {
        if (!voiceChannelActive || !user) {
            if (wsRef.current) wsRef.current.close();
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            setVoicePeers([]);
            const audioContainer = document.getElementById('remote-audio-container');
            if(audioContainer) audioContainer.innerHTML = '';
            return;
        }

        const peerConnections = new Map();
        const audioContainer = document.getElementById('remote-audio-container');
        const stunServer = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                localStreamRef.current = stream;
                wsRef.current = new WebSocket('ws://localhost:3001');

                wsRef.current.onopen = () => {
                    console.log("WebSocket connected, sending auth token...");
                    wsRef.current.send(JSON.stringify({
                        type: 'auth',
                        payload: { token: user.token }
                    }));
                };

                wsRef.current.onclose = () => {
                    if (localStreamRef.current) {
                        localStreamRef.current.getTracks().forEach(track => track.stop());
                    }
                };

                wsRef.current.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    const { type, payload } = message;
                    const { sourceClientId, sdp, candidate, existingPeers, ...newPeerInfo } = payload;

                    const createPeerConnection = (targetClientId) => {
                        const peer = new RTCPeerConnection(stunServer);
                        peerConnections.set(targetClientId, peer);

                        stream.getTracks().forEach(track => peer.addTrack(track, stream));

                        peer.ontrack = (event) => {
                            let audioEl = document.getElementById(`audio-${targetClientId}`);
                            if (!audioEl) {
                                audioEl = document.createElement('audio');
                                audioEl.id = `audio-${targetClientId}`;
                                audioEl.autoplay = true;
                                audioEl.playsInline = true;
                                if(audioContainer) audioContainer.appendChild(audioEl);
                            }
                            audioEl.srcObject = event.streams[0];
                        };

                        peer.onicecandidate = (event) => {
                            if (event.candidate) {
                                wsRef.current.send(JSON.stringify({
                                    type: 'ice-candidate',
                                    payload: { targetClientId, candidate: event.candidate }
                                }));
                            }
                        };
                        
                        peer.onconnectionstatechange = () => {
                            if (peer.connectionState === 'disconnected' || peer.connectionState === 'closed' || peer.connectionState === 'failed') {
                                let audioEl = document.getElementById(`audio-${targetClientId}`);
                                if(audioEl) audioEl.remove();
                                peerConnections.delete(targetClientId);
                                setVoicePeers(prev => prev.filter(p => p.clientId !== targetClientId));
                            }
                        };
                        return peer;
                    };

                    switch (type) {
                        case 'connection-success':
                            myClientIdRef.current = payload.clientId;
                            setVoicePeers(existingPeers);
                            existingPeers.forEach(peer => {
                                const newPeerConnection = createPeerConnection(peer.clientId);
                                newPeerConnection.createOffer()
                                    .then(offer => newPeerConnection.setLocalDescription(offer))
                                    .then(() => {
                                        wsRef.current.send(JSON.stringify({
                                            type: 'offer',
                                            payload: { targetClientId: peer.clientId, sdp: newPeerConnection.localDescription }
                                        }));
                                    });
                            });
                            break;
                        case 'new-peer':
                            setVoicePeers(prev => [...prev, newPeerInfo]);
                            const peerForOffer = createPeerConnection(newPeerInfo.clientId);
                            peerForOffer.createOffer()
                                .then(offer => peerForOffer.setLocalDescription(offer))
                                .then(() => {
                                    wsRef.current.send(JSON.stringify({
                                        type: 'offer',
                                        payload: { targetClientId: newPeerInfo.clientId, sdp: peerForOffer.localDescription }
                                    }));
                                });
                            break;
                        case 'offer':
                            const peerForAnswer = createPeerConnection(sourceClientId);
                            peerForAnswer.setRemoteDescription(new RTCSessionDescription(sdp))
                                .then(() => peerForAnswer.createAnswer())
                                .then(answer => peerForAnswer.setLocalDescription(answer))
                                .then(() => {
                                    wsRef.current.send(JSON.stringify({
                                        type: 'answer',
                                        payload: { targetClientId: sourceClientId, sdp: peerForAnswer.localDescription }
                                    }));
                                });
                            break;
                        case 'answer':
                            const peerToAnswer = peerConnections.get(sourceClientId);
                            if (peerToAnswer) {
                                peerToAnswer.setRemoteDescription(new RTCSessionDescription(sdp));
                            }
                            break;
                        case 'ice-candidate':
                            const peerForCandidate = peerConnections.get(sourceClientId);
                            if (peerForCandidate) {
                                peerForCandidate.addIceCandidate(new RTCIceCandidate(candidate));
                            }
                            break;
                        case 'peer-left':
                            setVoicePeers(prev => prev.filter(p => p.clientId !== payload.clientId));
                            const peerToClose = peerConnections.get(payload.clientId);
                            if (peerToClose) peerToClose.close();
                            let audioEl = document.getElementById(`audio-${payload.clientId}`);
                            if (audioEl) audioEl.remove();
                            peerConnections.delete(payload.clientId);
                            break;
                        default:
                            break;
                    }
                };
            }).catch(err => {
                console.error("Mic access error:", err);
                setVoiceChannelActive(false);
            });

        return () => {
            if (wsRef.current) wsRef.current.close();
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            peerConnections.forEach(peer => peer.close());
        };
    }, [voiceChannelActive, user, user?.token]);

    // --- Admin/Auth/Chat Functions ---
    const fetchAllUsers = useCallback(async () => {
        if (!user || !user.isAdmin) return;
        try {
            const data = await authenticatedFetch('/api/admin/users');
            setAllUsers(data);
        } catch (error) {
            console.error('Error fetching users (admin):', error);
        }
    }, [user, authenticatedFetch]);

    useEffect(() => {
        if (user && user.isAdmin && showAdminPanel) {
            fetchAllUsers();
        } else {
            setAllUsers([]);
        }
    }, [user, showAdminPanel, fetchAllUsers]);

    const handleAuth = async (e) => {
        e.preventDefault();
        setAuthError('');
        try {
            const endpoint = isRegistering ? '/api/register' : '/api/login';
            const data = await authenticatedFetch(endpoint, {
                method: 'POST',
                body: JSON.stringify({ username: loginUsername, password: loginPassword })
            });
            const newUser = {
                userId: data.userId,
                userName: data.userName,
                isAdmin: data.isAdmin,
                profilePhotoUrl: data.profilePhotoUrl,
                token: data.token
            };
            setUser(newUser);
            localStorage.setItem('token', newUser.token);
            localStorage.setItem('user', JSON.stringify({
                userId: newUser.userId,
                userName: newUser.userName,
                isAdmin: newUser.isAdmin,
                profilePhotoUrl: newUser.profilePhotoUrl
            }));
            setLoginUsername('');
            setLoginPassword('');
        } catch (error) {
            setAuthError(error.message);
        }
    };

    const handleLogout = () => {
        setUser(null);
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setMessages([]);
        setAllUsers([]);
        setChannels([]);
        setActiveChannelId(null);
        setVoiceChannelActive(false);
    };

    const sendMessage = async (e) => {
        e.preventDefault();
        if (newMessage.trim() === '' || !user || !activeChannelId) return;
    
        const tempMessage = {
            id: `temp-${Date.now()}`,
            channel_id: activeChannelId,
            user_id: user.userId,
            username: user.userName,
            profile_photo_url: user.profilePhotoUrl,
            text: newMessage,
            timestamp: new Date().toISOString(),
        };
    
        setMessages(prevMessages => [...prevMessages, tempMessage]);
        setNewMessage('');
    
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 100);
    
        try {
            await authenticatedFetch(`/api/messages/${activeChannelId}`, {
                method: 'POST',
                body: JSON.stringify({ text: tempMessage.text })
            });
        } catch (error) {
            console.error('Error sending message:', error);
            setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(e);
        }
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file || !user || !activeChannelId) return;
        setUploadingFile(file.name);
        setUploadProgress(0);
        setUploadError(null);
        const formData = new FormData();
        formData.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE_URL}/api/upload/${activeChannelId}`, true);
        xhr.setRequestHeader('Authorization', `Bearer ${user.token}`);
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                const progress = (event.loaded / event.total) * 100;
                setUploadProgress(progress);
            }
        };
        xhr.onload = () => {
            if (xhr.status === 201) {
                setUploadingFile(null);
                fetchMessages(false);
            } else {
                const errorResponse = JSON.parse(xhr.responseText);
                setUploadError(errorResponse.message || 'Failed to upload file.');
                setUploadingFile(null);
            }
        };
        xhr.onerror = () => {
            setUploadError('Network error during upload.');
            setUploadingFile(null);
        };
        xhr.send(formData);
    };

    const deleteMessage = async (messageId) => {
        if (!user || !user.isAdmin) return;
        try {
            await authenticatedFetch(`/api/admin/messages/${messageId}`, { method: 'DELETE' });
            fetchMessages(false);
        } catch (error) {
            console.error('Error deleting message:', error);
        }
    };

    const toggleAdminStatus = async (targetUserId, currentIsAdmin) => {
        if (!user || !user.isAdmin) return;
        try {
            await authenticatedFetch(`/api/admin/users/${targetUserId}/toggle-admin`, {
                method: 'POST',
                body: JSON.stringify({ isAdmin: !currentIsAdmin })
            });
            fetchAllUsers();
        } catch (error) {
            console.error('Error toggling admin status:', error);
        }
    };

    const handleProfileUpdate = async (e) => {
        e.preventDefault();
        setProfileUpdateError('');
        try {
            if (newDisplayName.trim() !== user.userName) {
                const data = await authenticatedFetch('/api/profile', {
                    method: 'PUT',
                    body: JSON.stringify({ userName: newDisplayName })
                });
                const updatedUser = { ...user, userName: data.userName, token: data.token };
                setUser(updatedUser);
                localStorage.setItem('token', updatedUser.token);
                localStorage.setItem('user', JSON.stringify({
                    userId: updatedUser.userId,
                    userName: updatedUser.userName,
                    isAdmin: updatedUser.isAdmin,
                    profilePhotoUrl: updatedUser.profilePhotoUrl
                }));
            }
            if (newProfilePhoto) {
                const formData = new FormData();
                formData.append('profilePhoto', newProfilePhoto);
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${API_BASE_URL}/api/profile/photo`, true);
                xhr.setRequestHeader('Authorization', `Bearer ${user.token}`);
                xhr.onload = () => {
                    if (xhr.status === 200) {
                        const data = JSON.parse(xhr.responseText);
                        const updatedUser = { ...user, profilePhotoUrl: data.profilePhotoUrl, token: data.token };
                        setUser(updatedUser);
                        localStorage.setItem('token', updatedUser.token);
                        localStorage.setItem('user', JSON.stringify({
                            userId: updatedUser.userId,
                            userName: updatedUser.userName,
                            isAdmin: updatedUser.isAdmin,
                            profilePhotoUrl: updatedUser.profilePhotoUrl
                        }));
                        setNewProfilePhoto(null);
                    } else {
                        const errorResponse = JSON.parse(xhr.responseText);
                        setProfileUpdateError(errorResponse.message || 'Failed to upload profile photo.');
                    }
                };
                xhr.send(formData);
            }
            setShowProfileModal(false);
        } catch (error) {
            setProfileUpdateError(error.message);
        }
    };

    const handleCreateChannel = async (e) => {
        e.preventDefault();
        setCreateChannelError('');
        if (!newChannelName.trim()) {
            setCreateChannelError('Channel name cannot be empty.');
            return;
        }
        try {
            await authenticatedFetch('/api/channels', {
                method: 'POST',
                body: JSON.stringify({ name: newChannelName })
            });
            setNewChannelName('');
            setShowCreateChannelModal(false);
            fetchChannels();
        } catch (error) {
            setCreateChannelError(error.message);
        }
    };

    // --- Render UI ---
    if (!user) {
        return (
            <div className="h-screen bg-gradient-to-br from-purple-950 to-indigo-950 text-white font-sans flex flex-col items-center justify-center p-4">
                <div className="w-full max-w-md bg-black bg-opacity-70 rounded-xl shadow-2xl p-8 border border-purple-800 backdrop-blur-sm">
                    <h1 className="text-4xl font-extrabold text-center mb-8 text-purple-300 drop-shadow-lg">
                        {isRegistering ? 'Join the Hub' : 'Welcome Back'}
                    </h1>
                    {authError && <div className="bg-red-700 text-white p-4 rounded-lg mb-6 text-center">{authError}</div>}
                    <form onSubmit={handleAuth} className="space-y-6">
                        <input type="text" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} className="w-full py-3 px-4 rounded-lg bg-black bg-opacity-50 border border-purple-700 focus:ring-2 focus:ring-purple-400" placeholder="Username" required />
                        <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} className="w-full py-3 px-4 rounded-lg bg-black bg-opacity-50 border border-purple-700 focus:ring-2 focus:ring-purple-400" placeholder="Password" required />
                        <button type="submit" className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-3 px-4 rounded-lg">{isRegistering ? 'Register' : 'Login'}</button>
                    </form>
                    <button onClick={() => setIsRegistering(!isRegistering)} className="mt-6 w-full text-sm text-center text-purple-300 hover:text-purple-100">
                        {isRegistering ? 'Already have an account? Login.' : 'Need an account? Register.'}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen bg-gradient-to-br from-purple-950 to-indigo-950 text-white font-sans flex p-4">
            {/* Left Sidebar */}
            <div className="w-64 bg-black bg-opacity-70 rounded-xl shadow-2xl p-4 flex flex-col mr-4 border border-purple-800">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-purple-700">
                    <h2 className="text-2xl font-bold text-purple-300">Channels</h2>
                    <button onClick={() => setShowCreateChannelModal(true)} className="p-2 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full hover:from-purple-700 hover:to-indigo-700" title="Create New Channel">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd"></path></svg>
                    </button>
                </div>
                <div className="flex-grow overflow-y-auto custom-scrollbar mb-4">
                    {channels.map((channel) => (
                        <button key={channel.id} onClick={() => setActiveChannelId(channel.id)} className={`w-full text-left py-2 px-3 rounded-lg mb-2 transition ${activeChannelId === channel.id ? 'bg-purple-800 text-purple-100' : 'hover:bg-purple-900 text-purple-300'}`}>
                            # {channel.name}
                        </button>
                    ))}
                </div>
                <div className="mt-auto pt-4 border-t border-purple-700">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center">
                            <img src={`${API_BASE_URL}${user.profilePhotoUrl}`} alt="Profile" className="w-10 h-10 rounded-full border-2 border-purple-400 object-cover mr-3" />
                            <span className="font-semibold text-purple-100">{user.userName}</span>
                        </div>
                        <button onClick={() => setShowProfileModal(true)} className="p-2 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full hover:from-purple-700 hover:to-indigo-700" title="Edit Profile">
                           <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zm-6.071 6.071l-1.071 4.286 4.286-1.071L14.364 7.636l-2.828-2.828-6.07 6.07z" /></svg>
                        </button>
                    </div>
                    {user.isAdmin && <button onClick={() => setShowAdminPanel(!showAdminPanel)} className="w-full px-3 py-2 text-sm bg-purple-900 hover:bg-purple-800 rounded-lg mb-2">{showAdminPanel ? 'Hide Admin' : 'Show Admin'}</button>}
                    <button onClick={handleLogout} className="w-full px-3 py-2 text-sm bg-red-700 hover:bg-red-800 rounded-lg">Logout</button>
                </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-grow bg-black bg-opacity-70 rounded-xl shadow-2xl p-6 flex flex-col border border-purple-800">
                <h1 className="text-3xl font-bold text-center mb-6 text-purple-300 drop-shadow-lg">
                    {activeChannelId ? `# ${channels.find(c => c.id === activeChannelId)?.name || '...'}` : 'Select a Channel'}
                </h1>

                {/* Voice Channel UI */}
                <div className="mb-4 text-center">
                    <button
                        onClick={() => setVoiceChannelActive(!voiceChannelActive)}
                        className={`px-4 py-2 font-semibold rounded-lg shadow-md transition-all ${voiceChannelActive ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
                    >
                        {voiceChannelActive ? 'Leave Voice Channel' : 'Join Voice Channel'}
                    </button>
                    {voiceChannelActive && (
                        <div className="flex justify-center items-center mt-3 space-x-2">
                            <div title={`You (${user.userName})`}>
                                <img src={`${API_BASE_URL}${user.profilePhotoUrl}`} alt={user.userName} className="w-10 h-10 rounded-full border-2 border-green-400 object-cover" />
                            </div>
                            {voicePeers.map(peer => (
                                <div key={peer.clientId} title={peer.userName}>
                                    <img src={`${API_BASE_URL}${peer.profilePhotoUrl}`} alt={peer.userName} className="w-10 h-10 rounded-full border-2 border-gray-400 object-cover" />
                                </div>
                            ))}
                        </div>
                    )}
                    <div id="remote-audio-container"></div>
                </div>
                
                {showAdminPanel && user.isAdmin && (
                    <div className="border border-purple-700 rounded-lg p-4 mb-4 bg-black bg-opacity-60">
                        <h2 className="text-xl font-semibold mb-4 text-purple-300">Admin Panel</h2>
                        <div className="overflow-y-auto max-h-60 custom-scrollbar">
                            {allUsers.map((u) => (
                                <div key={u.user_id} className="flex items-center justify-between p-2 border-b border-purple-700">
                                    <span>{u.username}</span>
                                    <button onClick={() => toggleAdminStatus(u.user_id, u.is_admin)} className={`px-3 py-1 rounded-md text-sm font-semibold ${u.is_admin ? 'bg-red-600' : 'bg-blue-600'}`} disabled={u.user_id === user.userId}>
                                        {u.is_admin ? 'Revoke Admin' : 'Make Admin'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                
                <div ref={messageContainerRef} className="flex-grow overflow-y-auto border border-purple-700 rounded-lg p-4 mb-4 bg-black bg-opacity-60 custom-scrollbar">
                    {isChannelLoading ? <div className="text-center">Loading...</div> : (
                        <>
                            {hasMoreMessages && <div className="text-center mb-4"><button onClick={() => fetchMessages(true)} disabled={isLoadingMore} className="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded-lg">{isLoadingMore ? 'Loading...' : 'Load More'}</button></div>}
                            {messages.length === 0 && !hasMoreMessages ? <div className="text-center">No messages yet.</div> : messages.map((msg) => (
                                <div key={msg.id} className={`mb-3 p-3 rounded-lg max-w-[80%] relative flex items-start gap-3 ${msg.user_id === user.userId ? 'bg-purple-900 ml-auto' : 'bg-indigo-900 mr-auto'}`}>
                                    <img src={`${API_BASE_URL}${msg.profile_photo_url}`} alt="P" className="w-10 h-10 rounded-full border-2 border-purple-500 object-cover" />
                                    <div className="flex-grow">
                                        <div className="font-semibold text-sm mb-1">{msg.user_id === user.userId ? 'You' : msg.username}</div>
                                        {msg.text && <p className="break-words">{msg.text}</p>}
                                        {msg.file_url && (
                                            <div className="mt-2">
                                                {msg.file_type?.startsWith('image/') ? <img src={`${API_BASE_URL}${msg.file_url}`} alt={msg.file_name} className="max-w-full rounded-md" />
                                                : msg.file_type?.startsWith('video/') ? <video controls src={`${API_BASE_URL}${msg.file_url}`} className="max-w-full rounded-md" />
                                                : msg.file_type?.startsWith('audio/') ? <audio controls src={`${API_BASE_URL}${msg.file_url}`} className="w-full" />
                                                : <a href={`${API_BASE_URL}${msg.file_url}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{msg.file_name}</a>}
                                            </div>
                                        )}
                                        <div className="text-right text-xs text-purple-300 mt-1">{new Date(msg.timestamp).toLocaleString()}</div>
                                    </div>
                                    {user.isAdmin && <button onClick={() => deleteMessage(msg.id)} className="absolute top-1 right-1 text-red-400 p-1 rounded-full bg-black bg-opacity-50" title="Delete Message"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm6 0a1 1 0 01-2 0v6a1 1 0 112 0V8z" clipRule="evenodd"></path></svg></button>}
                                </div>
                            ))}
                        </>
                    )}
                    <div ref={messagesEndRef} />
                    <div ref={messagesStartRef} />
                </div>
                
                <div className="flex flex-col sm:flex-row gap-3 mt-auto">
                    <input type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} onKeyDown={handleKeyDown} placeholder="Type your message..." className="flex-grow p-3 rounded-lg bg-purple-900 border border-purple-800 focus:ring-2 focus:ring-purple-400" disabled={!activeChannelId} />
                    <button onClick={sendMessage} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 font-bold rounded-lg" disabled={!activeChannelId}>Send</button>
                    <label className={`px-6 py-3 bg-gradient-to-r from-purple-900 to-indigo-900 hover:from-purple-800 hover:to-indigo-800 font-bold rounded-lg cursor-pointer text-center ${!activeChannelId && 'opacity-50'}`}>Upload<input type="file" onChange={handleFileUpload} className="hidden" disabled={!activeChannelId} /></label>
                </div>
                {uploadingFile && <div className="mt-4 text-center"><p>Uploading: {uploadingFile}</p><div className="w-full bg-purple-800 rounded-full h-2.5 mt-2"><div className="bg-blue-500 h-2.5 rounded-full" style={{ width: `${uploadProgress}%` }}></div></div></div>}
                {uploadError && <div className="mt-4 text-center text-red-500">{uploadError}</div>}
            </div>

            {/* Modals */}
            {showProfileModal && (
                <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
                    <div className="bg-black bg-opacity-80 rounded-xl p-8 w-full max-w-md border border-purple-800 relative">
                        <h2 className="text-3xl font-bold text-purple-300 mb-6 text-center">Edit Profile</h2>
                        <button onClick={() => setShowProfileModal(false)} className="absolute top-4 right-4 text-purple-300 hover:text-white"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                        {profileUpdateError && <div className="bg-red-700 p-3 rounded-md mb-4 text-center">{profileUpdateError}</div>}
                        <form onSubmit={handleProfileUpdate} className="space-y-5">
                            <input type="text" value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} className="w-full p-2 rounded-lg bg-purple-900 border border-purple-800" placeholder="Display Name" required />
                            <input type="file" accept="image/*" onChange={(e) => setNewProfilePhoto(e.target.files[0])} className="w-full text-purple-300 file:bg-purple-600 file:border-0 file:rounded-full file:px-4 file:py-2" />
                            <button type="submit" className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 font-bold py-3 rounded-lg">Save Changes</button>
                        </form>
                    </div>
                </div>
            )}
            {showCreateChannelModal && (
                 <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
                    <div className="bg-black bg-opacity-80 rounded-xl p-8 w-full max-w-sm border border-purple-800 relative">
                        <h2 className="text-3xl font-bold text-purple-300 mb-6 text-center">Create Channel</h2>
                        <button onClick={() => setShowCreateChannelModal(false)} className="absolute top-4 right-4 text-purple-300 hover:text-white"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                        {createChannelError && <div className="bg-red-700 p-3 rounded-md mb-4 text-center">{createChannelError}</div>}
                        <form onSubmit={handleCreateChannel} className="space-y-5">
                            <input type="text" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} className="w-full p-2 rounded-lg bg-purple-900 border border-purple-800" placeholder="Channel Name" required />
                            <button type="submit" className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 font-bold py-3 rounded-lg">Create</button>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;