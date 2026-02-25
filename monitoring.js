// Performance Monitoring System
const fs = require('fs');
const path = require('path');

class BotMonitor {
  constructor() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      activeUsers: new Set(),
      commandCounts: {},
      responseTimes: [],
      errors: [],
      startTime: Date.now(),
      hourlyStats: {},
      memoryUsage: [],
      databaseQueries: 0,
      apiCalls: 0
    };
    
    this.loadStats();
    this.startMonitoring();
  }

  // Statistikani yuklash
  loadStats() {
    try {
      const statsFile = path.join(__dirname, 'bot-stats.json');
      if (fs.existsSync(statsFile)) {
        const data = fs.readFileSync(statsFile, 'utf8');
        const saved = JSON.parse(data);
        this.stats = { ...this.stats, ...saved };
        this.stats.activeUsers = new Set(saved.activeUsers || []);
      }
    } catch (err) {
      console.log('⚠️ Statistika yuklashda xato:', err.message);
    }
  }

  // Statistikani saqlash
  saveStats() {
    try {
      const statsFile = path.join(__dirname, 'bot-stats.json');
      const data = {
        ...this.stats,
        activeUsers: Array.from(this.stats.activeUsers),
        lastSaved: Date.now()
      };
      fs.writeFileSync(statsFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.log('⚠️ Statistika saqlashda xato:', err.message);
    }
  }

  // Monitoring boshlash (soddalashtirilgan)
  startMonitoring() {
    // Faqat har soatda statistikani saqlash
    setInterval(() => {
      this.cleanupOldStats(); // Eski statistikani tozalash
      this.saveStats();
    }, 60 * 60 * 1000); // Har soatda
  }

  // Request tracking (faqat 1 soatlik statistika)
  trackRequest(userId, command, responseTime, success = true) {
    // Soatlik statistika
    const currentHour = new Date().getHours();
    if (!this.stats.hourlyStats[currentHour]) {
      this.stats.hourlyStats[currentHour] = {
        requests: 0,
        successfulRequests: 0,
        users: new Set()
      };
    }
    
    this.stats.hourlyStats[currentHour].requests++;
    
    if (success) {
      this.stats.hourlyStats[currentHour].successfulRequests++;
    }
    
    this.stats.hourlyStats[currentHour].users.add(userId);
  }

  // Error tracking
  trackError(error, userId, command) {
    this.stats.errors.push({
      error: error.message || error,
      userId,
      command,
      timestamp: Date.now()
    });

    // Keep only last 100 errors
    if (this.stats.errors.length > 100) {
      this.stats.errors = this.stats.errors.slice(-100);
    }
  }

  // Database query tracking
  trackDatabaseQuery() {
    this.stats.databaseQueries++;
  }

  // API call tracking
  trackApiCall() {
    this.stats.apiCalls++;
  }

  // Memory usage recording
  recordMemoryUsage() {
    const usage = process.memoryUsage();
    this.stats.memoryUsage.push({
      ...usage,
      timestamp: Date.now()
    });

    // Keep only last 100 records
    if (this.stats.memoryUsage.length > 100) {
      this.stats.memoryUsage = this.stats.memoryUsage.slice(-100);
    }
  }

  // Get current stats (faqat 1 soatlik statistika)
  getCurrentStats() {
    const uptime = Date.now() - this.stats.startTime;
    
    // Soatlik statistika
    const currentHour = new Date().getHours();
    const hourlyStats = this.stats.hourlyStats[currentHour] || {
      requests: 0,
      successfulRequests: 0,
      users: new Set()
    };
    
    // 1 soatlik muvaffaqiyat foizi
    const hourlySuccessRate = hourlyStats.requests > 0 
      ? (hourlyStats.successfulRequests / hourlyStats.requests) * 100 
      : 0;

    // 1 soatlik faol foydalanuvchilar
    const hourlyActiveUsers = hourlyStats.users.size;

    // 24 soatlik so'rovlar
    let total24HourRequests = 0;
    for (let hour = 0; hour < 24; hour++) {
      if (this.stats.hourlyStats[hour]) {
        total24HourRequests += this.stats.hourlyStats[hour].requests;
      }
    }

    return {
      successRate: hourlySuccessRate.toFixed(2) + '%', // 1 soatlik muvaffaqiyat foizi
      activeUsers: hourlyActiveUsers, // 1 soatlik faol foydalanuvchilar
      hourlyRequests: hourlyStats.requests, // 1 soatlik so'rovlar
      total24HourRequests: total24HourRequests, // 24 soatlik so'rovlar
      uptime: this.formatUptime(uptime)
    };
  }

  // Print stats to console (faqat 1 soatlik statistika)
  printStats() {
    const stats = this.getCurrentStats();
    console.log('\n📊 === BOT STATISTIKASI ===');
    console.log(`✅ 1 soatlik muvaffaqiyat foizi: ${stats.successRate}`);
    console.log(`👥 1 soatlik faol foydalanuvchilar: ${stats.activeUsers}`);
    console.log(`📊 1 soatlik so'rovlar: ${stats.hourlyRequests}`);
    console.log(`📈 24 soatlik so'rovlar: ${stats.total24HourRequests}`);
    console.log('================================\n');
  }

  // Format uptime
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    return `${days}k ${hours % 24}soat ${minutes % 60}daq ${seconds % 60}son`;
  }

  // Format bytes
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Cleanup old stats
  cleanupOldStats() {
    // Keep only last 24 hours of hourly stats
    const currentHour = new Date().getHours();
    Object.keys(this.stats.hourlyStats).forEach(hour => {
      if (Math.abs(hour - currentHour) > 24) {
        delete this.stats.hourlyStats[hour];
      }
    });
  }

  // Get health status (faqat kerakli narsalar)
  getHealthStatus() {
    const stats = this.getCurrentStats();
    const successRate = parseFloat(stats.successRate);

    let status = '🟢 SOG\'LOM';
    let issues = [];

    if (successRate < 95) {
      status = '🟡 DIQQAT';
      issues.push('Past muvaffaqiyat foizi');
    }

    return {
      status,
      issues,
      ...stats
    };
  }
}

module.exports = BotMonitor;
