import React, { useState, useEffect, useRef, useCallback } from 'react';

// Base URL for your backend API.
// IMPORTANT: Replace this with your Cloudflare Tunnel URL once configured.
// During local development, it might be 'http://localhost:3001' or 'http://your-truenas-ip:3001'
const API_BASE_URL = 'http://localhost:3001'; // Placeholder: Update this for deployment!

function App() {
    const [user, setUser] = useState(null); // Stores { userId, userName, isAdmin, token, profilePhotoUrl }
    const [messages, setMessages] = useState([]); // Ensure initial state is an empty array
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

    // Pagination state
    const [messagesLimit] = useState(20); // Number of messages to load per batch
    const [hasMoreMessages, setHasMoreMessages] = useState(true); // True if there are more messages to load
    const [isLoadingMore, setIsLoadingMore] = useState(false); // State to prevent multiple load more calls
    const lastFetchedMessageIdRef = useRef(null); // Using a ref to prevent stale closures in polling

    // Loading state for channel switching
    const [isChannelLoading, setIsChannelLoading] = useState(false);


    const messagesEndRef = useRef(null); // For scrolling to latest message
    const messagesStartRef = useRef(null); // For scrolling to new top message after loading more
    const messageContainerRef = useRef(null); // For checking scroll position

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
                setActiveChannelId(data[0].id); // Set first channel as active by default
            }
        } catch (error) {
            console.error('Error fetching channels:', error);
            setAuthError(error.message);
        }
    }, [user, authenticatedFetch, activeChannelId]);

    useEffect(() => {
        fetchChannels();
    }, [fetchChannels]);


    // --- Fetch Messages for Active Channel (with Pagination Logic) ---
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
                console.error("Unexpected data format from API for messages:", data);
                setMessages([]);
                setHasMoreMessages(false);
            }
        } catch (error) {
            console.error('Error fetching messages:', error);
            if (error.message.includes('401') || error.message.includes('403')) {
                setUser(null);
                localStorage.removeItem('token');
                localStorage.removeItem('user');
            }
        } finally {
            setIsLoadingMore(false);
        }
    }, [user, activeChannelId, authenticatedFetch, messagesLimit, isLoadingMore]);


    // Handles initial load and sets up polling
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


    // --- Fetch All Users for Admin Panel ---
    const fetchAllUsers = useCallback(async () => {
        if (!user || !user.isAdmin) return;
        try {
            const data = await authenticatedFetch('/api/admin/users');
            setAllUsers(data);
        } catch (error) {
            console.error('Error fetching users (admin):', error);
            setAuthError(error.message);
        }
    }, [user, authenticatedFetch]);

    useEffect(() => {
        if (user && user.isAdmin && showAdminPanel) {
            fetchAllUsers();
        } else {
            setAllUsers([]);
        }
    }, [user, showAdminPanel, fetchAllUsers]);


    // --- Authentication Functions ---
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
            setNewDisplayName(newUser.userName);
            setLoginUsername('');
            setLoginPassword('');
        } catch (error) {
            setAuthError(error.message);
            console.error('Authentication error:', error);
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
        setShowAdminPanel(false);
        setShowProfileModal(false);
        setHasMoreMessages(true);
        lastFetchedMessageIdRef.current = null;
    };

    // --- Chat Functions ---
    const sendMessage = async (e) => {
        e.preventDefault();
        if (newMessage.trim() === '' || !user || !activeChannelId) return;

        try {
            await authenticatedFetch(`/api/messages/${activeChannelId}`, {
                method: 'POST',
                body: JSON.stringify({ text: newMessage })
            });
            setNewMessage('');
            fetchMessages(false);
        } catch (error) {
            console.error('Error sending message:', error);
            setAuthError(error.message);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(e);
        }
    };

    // --- File Upload Function ---
    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file || !user || !activeChannelId) return;

        setUploadingFile(file.name);
        setUploadProgress(0);
        setUploadError(null);

        const formData = new FormData();
        formData.append('file', file);

        try {
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
                    setUploadProgress(0);
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

        } catch (error) {
            console.error('Error initiating file upload:', error);
            setUploadError('Failed to initiate upload.');
            setUploadingFile(null);
        }
    };

    // --- Admin Functions ---
    const deleteMessage = async (messageId) => {
        if (!user || !user.isAdmin) return;
        try {
            await authenticatedFetch(`/api/admin/messages/${messageId}`, {
                method: 'DELETE'
            });
            fetchMessages(false);
        } catch (error) {
            console.error('Error deleting message:', error);
            setAuthError(error.message);
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
            setAuthError(error.message);
        }
    };

    // --- Profile Management Functions ---
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
                xhr.onerror = () => {
                    setProfileUpdateError('Network error during profile photo upload.');
                };
                xhr.send(formData);
            }

            setShowProfileModal(false);
        } catch (error) {
            setProfileUpdateError(error.message);
            console.error('Error updating profile:', error);
        }
    };

    // --- Channel Creation Functions ---
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
            console.error('Error creating channel:', error);
        }
    };


    // --- Render Login/Chat UI ---
    if (!user) {
        return (
            <div className="h-screen bg-gradient-to-br from-purple-950 to-indigo-950 text-white font-sans flex flex-col items-center justify-center p-4">
                {/* Login/Register Panel */}
                <div className="w-full max-w-md bg-black bg-opacity-70 rounded-xl shadow-2xl p-8 border border-purple-800 backdrop-blur-sm transform hover:scale-105 transition-all duration-300 ease-in-out">
                    <h1 className="text-4xl font-extrabold text-center mb-8 text-purple-300 drop-shadow-lg animate-pulse">
                        {isRegistering ? 'Join the Hub' : 'Welcome Back'}
                    </h1>
                    {authError && (
                        <div className="bg-red-700 text-white p-4 rounded-lg mb-6 text-center shadow-inner border border-red-500">
                            {authError}
                        </div>
                    )}
                    <form onSubmit={handleAuth} className="space-y-6">
                        <div>
                            <label className="block text-purple-200 text-sm font-semibold mb-2" htmlFor="username">
                                Username
                            </label>
                            <input
                                type="text"
                                id="username"
                                value={loginUsername}
                                onChange={(e) => setLoginUsername(e.target.value)}
                                className="w-full py-3 px-4 rounded-lg bg-black bg-opacity-50 border border-purple-700 text-white placeholder-purple-300 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition duration-200 shadow-inner"
                                placeholder="Choose a username"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-purple-200 text-sm font-semibold mb-2" htmlFor="password">
                                Password
                            </label>
                            <input
                                type="password"
                                id="password"
                                value={loginPassword}
                                onChange={(e) => setLoginPassword(e.target.value)}
                                className="w-full py-3 px-4 rounded-lg bg-black bg-opacity-50 border border-purple-700 text-white placeholder-purple-300 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition duration-200 shadow-inner"
                                placeholder="Enter your password"
                                required
                            />
                        </div>
                        <button
                            type="submit"
                            className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-3 px-4 rounded-lg shadow-lg hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-75 transition duration-300 ease-in-out transform hover:-translate-y-0.5"
                        >
                            {isRegistering ? 'Register Account' : 'Login'}
                        </button>
                    </form>
                    <button
                        onClick={() => setIsRegistering(!isRegistering)}
                        className="mt-6 w-full text-sm text-center text-purple-300 hover:text-purple-100 transition duration-300"
                    >
                        {isRegistering ? 'Already have an account? Login here.' : 'Need an account? Register here.'}
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
                    <button
                        onClick={() => setShowCreateChannelModal(true)}
                        className="p-2 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full hover:from-purple-700 hover:to-indigo-700 transition duration-200 shadow-md hover:shadow-lg"
                        title="Create New Channel"
                    >
                        <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd"></path></svg>
                    </button>
                </div>
                <div className="flex-grow overflow-y-auto custom-scrollbar mb-4">
                    {channels.length === 0 ? (
                        <p className="text-purple-400 text-sm">No channels found. Create one!</p>
                    ) : (
                        channels.map((channel) => (
                            <button
                                key={channel.id}
                                onClick={() => setActiveChannelId(channel.id)}
                                className={`w-full text-left py-2 px-3 rounded-lg mb-2 transition duration-200 ${activeChannelId === channel.id ? 'bg-purple-800 text-purple-100 font-semibold shadow-inner' : 'hover:bg-purple-900 text-purple-300'}`}
                            >
                                # {channel.name}
                            </button>
                        ))
                    )}
                </div>

                {/* User Profile Section in Sidebar */}
                <div className="mt-auto pt-4 border-t border-purple-700">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center">
                            <img
                                src={`${API_BASE_URL}${user.profilePhotoUrl}`}
                                alt="Profile"
                                className="w-10 h-10 rounded-full border-2 border-purple-400 object-cover mr-3 shadow-lg"
                            />
                            <span className="font-semibold text-purple-100">{user.userName}</span>
                        </div>
                        <button
                            onClick={() => setShowProfileModal(true)}
                            className="p-2 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full hover:from-purple-700 hover:to-indigo-700 transition duration-200 shadow-md hover:shadow-lg"
                            title="Edit Profile"
                        >
                            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zm-6.071 6.071l-1.071 4.286 4.286-1.071L14.364 7.636l-2.828-2.828-6.07 6.07z" /></svg>
                        </button>
                    </div>
                    {user.isAdmin && (
                        <button
                            onClick={() => setShowAdminPanel(!showAdminPanel)}
                            className="w-full px-3 py-2 text-sm bg-purple-900 hover:bg-purple-800 text-purple-200 font-semibold rounded-lg transition duration-200 shadow-md hover:shadow-lg mb-2"
                        >
                            {showAdminPanel ? 'Hide Admin Panel' : 'Show Admin Panel'}
                        </button>
                    )}
                    <button
                        onClick={handleLogout}
                        className="w-full px-3 py-2 text-sm bg-red-700 hover:bg-red-800 text-white font-semibold rounded-lg transition duration-200 shadow-md hover:shadow-lg"
                    >
                        Logout
                    </button>
                </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-grow bg-black bg-opacity-70 rounded-xl shadow-2xl p-6 flex flex-col border border-purple-800">
                <h1 className="text-3xl font-bold text-center mb-6 text-purple-300 drop-shadow-lg">
                    {activeChannelId ? `# ${channels.find(c => c.id === activeChannelId)?.name || 'Loading...'}` : 'Select a Channel'}
                </h1>

                {/* Admin Panel */}
                {showAdminPanel && user.isAdmin && (
                    <div className="border border-purple-700 rounded-lg p-4 mb-4 bg-black bg-opacity-60 shadow-inner">
                        <h2 className="text-xl font-semibold mb-4 text-purple-300">Admin Panel - User Management</h2>
                        <div className="overflow-y-auto max-h-60 custom-scrollbar">
                            {allUsers.length === 0 ? (
                                <p className="text-purple-400">No users registered yet.</p>
                            ) : (
                                allUsers.map((u) => (
                                    <div key={u.user_id} className="flex items-center justify-between p-2 border-b border-purple-700 last:border-b-0">
                                        <div className="flex items-center">
                                            <img
                                                src={`${API_BASE_URL}${u.profile_photo_url}`}
                                                alt="Profile"
                                                className="w-8 h-8 rounded-full border border-purple-500 object-cover mr-2 shadow-sm"
                                            />
                                            <span className="text-purple-200">{u.username} ({u.user_id})</span>
                                        </div>
                                        <button
                                            onClick={() => toggleAdminStatus(u.user_id, u.is_admin)}
                                            className={`px-3 py-1 rounded-md text-sm font-semibold ${u.is_admin ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'} text-white transition duration-200 shadow-md`}
                                            disabled={u.user_id === user.userId}
                                        >
                                            {u.is_admin ? 'Revoke Admin' : 'Make Admin'}
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}

                {/* Chat Section */}
                <div
                    ref={messageContainerRef}
                    className="flex-grow overflow-y-auto border border-purple-700 rounded-lg p-4 mb-4 bg-black bg-opacity-60 custom-scrollbar shadow-inner"
                >
                    {isChannelLoading ? (
                        <div className="text-center text-purple-400 mt-10">Loading channel...</div>
                    ) : (
                        <>
                            {hasMoreMessages && (
                                <div className="text-center mb-4">
                                    <button
                                        onClick={() => fetchMessages(true)}
                                        disabled={isLoadingMore}
                                        className="px-4 py-2 bg-purple-700 hover:bg-purple-600 text-white font-semibold rounded-lg transition duration-200 shadow-md"
                                    >
                                        {isLoadingMore ? 'Loading...' : 'Load More Messages'}
                                    </button>
                                </div>
                            )}
                            {messages.length === 0 && !hasMoreMessages ? (
                                <div className="text-center text-purple-400 mt-10">No messages yet. Start the conversation!</div>
                            ) : (
                                messages.map((msg) => (
                                    <div key={msg.id} className={`mb-3 p-3 rounded-lg max-w-[80%] relative flex items-start gap-3 shadow-md ${msg.user_id === user.userId ? 'bg-purple-900 ml-auto' : 'bg-indigo-900 mr-auto'}`}>
                                        <img
                                            src={`${API_BASE_URL}${msg.profile_photo_url}`}
                                            alt="Profile"
                                            className="w-10 h-10 rounded-full border-2 border-purple-500 object-cover flex-shrink-0 shadow-sm"
                                        />
                                        <div className="flex-grow">
                                            <div className="font-semibold text-sm mb-1 text-purple-200">
                                                {msg.user_id === user.userId ? 'You' : msg.username}
                                            </div>
                                            {msg.text && <p className="text-purple-100 break-words">{msg.text}</p>}
                                            {msg.file_url && (
                                                <div className="mt-2">
                                                    {msg.file_type && msg.file_type.startsWith('image/') ? (
                                                        <img src={`${API_BASE_URL}${msg.file_url}`} alt={msg.file_name} className="max-w-full rounded-md shadow-md" />
                                                    ) : msg.file_type && msg.file_type.startsWith('video/') ? (
                                                        <video controls src={`${API_BASE_URL}${msg.file_url}`} className="max-w-full rounded-md shadow-md" />
                                                    ) : msg.file_type && msg.file_type.startsWith('audio/') ? (
                                                        <audio controls src={`${API_BASE_URL}${msg.file_url}`} className="max-w-full rounded-md shadow-md" />
                                                    ) : (
                                                        <a href={`${API_BASE_URL}${msg.file_url}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline flex items-center">
                                                            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L11.586 2.586A2 2 0 0010.172 2H6zm0 2h4.586L14 7.414V16H6V4z" clipRule="evenodd"></path></svg>
                                                            Download: {msg.file_name}
                                                        </a>
                                                    )}
                                                    <p className="text-xs text-purple-300 mt-1">Uploaded: {msg.file_name}</p>
                                                </div>
                                            )}
                                            <div className="text-right text-xs text-purple-300 mt-1">
                                                {new Date(msg.timestamp).toLocaleString()}
                                            </div>
                                        </div>
                                        {user.isAdmin && (
                                            <button
                                                onClick={() => deleteMessage(msg.id)}
                                                className="absolute top-1 right-1 text-red-400 hover:text-red-500 p-1 rounded-full bg-black bg-opacity-50"
                                                title="Delete Message"
                                            >
                                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm6 0a1 1 0 01-2 0v6a1 1 0 112 0V8z" clipRule="evenodd"></path></svg>
                                            </button>
                                        )}
                                    </div>
                                ))
                            )}
                        </>
                    )}
                    <div ref={messagesEndRef} />
                    <div ref={messagesStartRef} />
                </div>

                {/* Message Input and File Upload */}
                <div className="flex flex-col sm:flex-row gap-3 mt-auto">
                    <input
                        type="text"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={activeChannelId ? "Type your message..." : "Select a channel to chat..."}
                        className="flex-grow p-3 rounded-lg bg-purple-900 border border-purple-800 text-white placeholder-purple-300 focus:outline-none focus:ring-2 focus:ring-purple-400 shadow-inner"
                        disabled={!activeChannelId}
                    />
                    <button
                        onClick={sendMessage}
                        className="px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105"
                        disabled={!activeChannelId}
                    >
                        Send
                    </button>
                    <label className={`px-6 py-3 bg-gradient-to-r from-purple-900 to-indigo-900 hover:from-purple-800 hover:to-indigo-800 text-white font-bold rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105 cursor-pointer text-center ${!activeChannelId ? 'opacity-50 cursor-not-allowed' : ''}`}>
                        Upload File
                        <input
                            type="file"
                            accept="*/*"
                            onChange={handleFileUpload}
                            className="hidden"
                            disabled={!activeChannelId}
                        />
                    </label>
                </div>

                {/* Upload Status */}
                {uploadingFile && (
                    <div className="mt-4 text-center">
                        <p className="text-purple-300">Uploading: {uploadingFile}</p>
                        <div className="w-full bg-purple-800 rounded-full h-2.5 mt-2 shadow-inner">
                            <div
                                className="bg-blue-500 h-2.5 rounded-full"
                                style={{ width: `${uploadProgress}%` }}
                            ></div>
                        </div>
                        <p className="text-sm text-purple-400 mt-1">{uploadProgress.toFixed(1)}%</p>
                    </div>
                )}
                {uploadError && (
                    <div className="mt-4 text-center text-red-500">
                        {uploadError}
                    </div>
                )}
            </div>

            {/* Profile Edit Modal */}
            {showProfileModal && (
                <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
                    <div className="bg-black bg-opacity-80 rounded-xl shadow-2xl p-8 w-full max-w-md border border-purple-800 relative transform hover:scale-105 transition-all duration-300 ease-in-out">
                        <h2 className="text-3xl font-bold text-purple-300 mb-6 text-center">Edit Profile</h2>
                        <button
                            onClick={() => setShowProfileModal(false)}
                            className="absolute top-4 right-4 text-purple-300 hover:text-white transition duration-200"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                        {profileUpdateError && (
                            <div className="bg-red-700 text-white p-3 rounded-md mb-4 text-center shadow-inner border border-red-500">
                                {profileUpdateError}
                            </div>
                        )}
                        <form onSubmit={handleProfileUpdate} className="space-y-5">
                            <div>
                                <label className="block text-purple-200 text-sm font-semibold mb-2">Display Name</label>
                                <input
                                    type="text"
                                    value={newDisplayName}
                                    onChange={(e) => setNewDisplayName(e.target.value)}
                                    className="w-full py-2 px-3 rounded-lg bg-purple-900 border border-purple-800 text-white focus:outline-none focus:ring-2 focus:ring-purple-400 shadow-inner"
                                    placeholder="Your new display name"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-purple-200 text-sm font-semibold mb-2">Profile Photo</label>
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={(e) => setNewProfilePhoto(e.target.files[0])}
                                    className="w-full text-purple-300 bg-purple-900 border border-purple-800 rounded-lg p-2 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-purple-600 file:text-white hover:file:bg-purple-700 transition duration-200"
                                />
                                {user.profilePhotoUrl && (
                                    <div className="mt-3 text-center">
                                        <p className="text-purple-300 text-sm mb-2">Current Photo:</p>
                                        <img src={`${API_BASE_URL}${user.profilePhotoUrl}`} alt="Current Profile" className="w-24 h-24 rounded-full object-cover mx-auto border-2 border-purple-400 shadow-lg" />
                                    </div>
                                )}
                            </div>
                            <button
                                type="submit"
                                className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-3 px-4 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105"
                            >
                                Save Changes
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* Create Channel Modal */}
            {showCreateChannelModal && (
                <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
                    <div className="bg-black bg-opacity-80 rounded-xl shadow-2xl p-8 w-full max-w-sm border border-purple-800 relative transform hover:scale-105 transition-all duration-300 ease-in-out">
                        <h2 className="text-3xl font-bold text-purple-300 mb-6 text-center">Create New Channel</h2>
                        <button
                            onClick={() => setShowCreateChannelModal(false)}
                            className="absolute top-4 right-4 text-purple-300 hover:text-white transition duration-200"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                        {createChannelError && (
                            <div className="bg-red-700 text-white p-3 rounded-md mb-4 text-center shadow-inner border border-red-500">
                                {createChannelError}
                            </div>
                        )}
                        <form onSubmit={handleCreateChannel} className="space-y-5">
                            <div>
                                <label className="block text-purple-200 text-sm font-semibold mb-2">Channel Name</label>
                                <input
                                    type="text"
                                    value={newChannelName}
                                    onChange={(e) => setNewChannelName(e.target.value)}
                                    className="w-full py-2 px-3 rounded-lg bg-purple-900 border border-purple-800 text-white focus:outline-none focus:ring-2 focus:ring-purple-400 shadow-inner"
                                    placeholder="e.g., general, gaming, memes"
                                    required
                                />
                            </div>
                            <button
                                type="submit"
                                className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-3 px-4 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105"
                            >
                                Create Channel
                            </button>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;