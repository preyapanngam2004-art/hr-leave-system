/* === 1. SETUP (ตั้งค่า) === */
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // ตัวช่วยส่งแจ้งเตือนเข้า Discord

// --- ⚠️ ส่วนตั้งค่า DISCORD (สำคัญ) ---
const DISCORD_WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1442683087795261562/p6kqq-gxCY5zwg5WR8Gw7rzcCj5Gdfvqi39le9E3xprM9rEm3BNUInH14fjEnWYZ4Cy3'; 

const app = express();
app.use(cors());
app.use(express.json());

// Static Files
app.use(express.static(path.join(__dirname))); 

// Uploads Folder
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Root Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
}); 


/* === 2. DATABASE CONNECTION (ใช้ Clever Cloud เพื่อให้ Render มองเห็น) === */
const pool = mysql.createPool({
    host: 'beo7a5e1cdpfctprqfrk-mysql.services.clever-cloud.com',
    user: 'utbsrjivbaog6owj',
    password: 'sSoDsDIaDFdD6Ifl0Y4t',
    database: 'beo7a5e1cdpfctprqfrk',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});


/* === 3. SETUP MULTER (จัดการอัปโหลดไฟล์) === */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });


/* === 4. API ENDPOINTS === */

// --- API 1: Login ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const [rows] = await pool.query(
            "SELECT * FROM employees WHERE Username = ? AND Password = ?",
            [username, password]
        );

        if (rows.length > 0) {
            res.json({ success: true, user: rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้ หรือ รหัสผ่านไม่ถูกต้อง' });
        }
    } catch (error) {
        console.error("Login API Error:", error);
        res.status(500).json({ success: false, message: 'Server Error: ' + error.message });
    }
});

// --- API 2: Pending Requests ---
app.get('/api/pending-requests/:managerId', async (req, res) => {
    try {
        const { managerId } = req.params; 
        const [rows] = await pool.query(`
            SELECT 
                lr.Request_ID, lr.StartDate, lr.Reason, lr.AttachmentFile,
                e.FirstName, e.LastName,
                lt.TypeName
            FROM leaverequests lr
            JOIN employees e ON lr.Emp_ID = e.Emp_ID
            JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID
            WHERE lr.Approver_ID = ? AND lr.Status = 'Pending'
            ORDER BY lr.StartDate ASC
        `, [managerId]);
        res.json(rows);
    } catch (error) {
        console.error("Pending API Error:", error);
        res.status(500).json({ message: 'Server Error: ' + error.message });
    }
});

// --- API 3: Approve/Reject (ส่งแจ้งเตือนเข้า Discord) ---
app.post('/api/process-request', async (req, res) => {
    const { requestId, newStatus } = req.body; 
    try {
        // 1. อัปเดต DB ก่อน
        await pool.query(
            "UPDATE leaverequests SET Status = ?, ApprovalDate = NOW() WHERE Request_ID = ?",
            [newStatus, requestId]
        );

        // 2. ตอบกลับหน้าเว็บทันที
        res.json({ message: `ดำเนินการ "${newStatus}" สำเร็จ` });

        // 3. ส่งแจ้งเตือนเข้า Discord
        (async () => {
            try {
                const [rows] = await pool.query(`
                    SELECT e.FirstName, lt.TypeName
                    FROM leaverequests lr
                    JOIN employees e ON lr.Emp_ID = e.Emp_ID
                    JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID
                    WHERE lr.Request_ID = ?
                `, [requestId]);

                if (rows.length > 0) {
                    const employee = rows[0];
                    const statusIcon = newStatus === 'Approved' ? '✅' : '❌';
                    const statusInThai = newStatus === 'Approved' ? 'อนุมัติ' : 'ปฏิเสธ';

                    // ข้อความที่จะส่งเข้า Discord
                    const discordMessage = {
                        content: `${statusIcon} **ผลการพิจารณาใบลา**\n👤 **ชื่อ:** ${employee.FirstName}\n📋 **สถานะ:** ${statusInThai}\n📄 **ประเภท:** ${employee.TypeName}`
                    };

                    await axios.post(DISCORD_WEBHOOK_URL, discordMessage);
                    console.log('แจ้งเตือน Discord สำเร็จ');
                }
            } catch (err) { console.error('Discord Error:', err.message); }
        })();

    } catch (error) {
        console.error("Process API Error:", error);
        if (!res.headersSent) res.status(500).json({ message: 'Server Error: ' + error.message });
    }
});


// --- API 4: Submit Leave (ส่งแจ้งเตือนเข้า Discord) ---
app.post('/api/submit-leave', upload.single('attachmentFile'), async (req, res) => {
    
    const { empId, leaveType, startDate, endDate, reason, managerId } = req.body;
    const attachmentPath = req.file ? req.file.filename : null; 
    const year = new Date(startDate).getFullYear();
    
    try {
        const [balanceRows] = await pool.query(
            "SELECT RemainingDays FROM leavebalances WHERE Emp_ID = ? AND LeaveType_ID = ? AND Year = ?",
            [empId, leaveType, year]
        );
        if (balanceRows.length === 0 || balanceRows[0].RemainingDays < 1) { 
            return res.status(400).json({ message: 'ใบลาไม่พอ หรือ ไม่พบโควต้าสำหรับปีนี้' });
        }
        
        // 1. บันทึกลง DB
        await pool.query(
            "INSERT INTO leaverequests (Emp_ID, LeaveType_ID, StartDate, EndDate, Reason, Approver_ID, Status, AttachmentFile) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?)",
            [empId, leaveType, startDate, endDate, reason, managerId, attachmentPath]
        );

        // 2. ตอบกลับหน้าเว็บทันที
        res.json({ message: 'ส่งใบลาสำเร็จ!' });

        // 3. ส่งแจ้งเตือนเข้า Discord
        (async () => {
            try {
                const [employeeRows] = await pool.query("SELECT FirstName, LastName FROM employees WHERE Emp_ID = ?", [empId]);
                
                if (employeeRows.length > 0) {
                    const employeeName = `${employeeRows[0].FirstName} ${employeeRows[0].LastName}`;
                    
                    // ข้อความที่จะส่งเข้า Discord
                    const discordMessage = {
                        content: `🔔 **มีคำขอใบลาใหม่!**\n👤 **จาก:** ${employeeName}\n📅 **วันที่:** ${startDate} ถึง ${endDate}\n📝 **เหตุผล:** ${reason}\n\n*กรุณาตรวจสอบในระบบเพื่ออนุมัติ*`
                    };

                    await axios.post(DISCORD_WEBHOOK_URL, discordMessage);
                    console.log('แจ้งเตือน Discord สำเร็จ');
                }
            } catch (err) { console.error('Discord Error:', err.message); }
        })();

    } catch (error) {
        console.error("Submit Leave Error:", error);
        if (!res.headersSent) res.status(500).json({ message: 'Server Error: ' + error.message });
    }
});

// --- API 5: Leave History ---
app.get('/api/leave-history/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const [rows] = await pool.query(`
            SELECT lr.*, lt.TypeName 
            FROM leaverequests lr
            JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID
            WHERE lr.Emp_ID = ?
            ORDER BY lr.StartDate DESC
        `, [empId]);
        res.json(rows);
    } catch (error) {
        console.error("History API Error:", error);
        res.status(500).json({ message: 'Server Error: ' + error.message });
    }
});

// --- API 6: Report ---
app.get('/api/report', async (req, res) => {
    try {
        const { startDate, endDate, deptId, leaveTypeId, status } = req.query;
        let sql = `
            SELECT 
                lr.StartDate, lr.EndDate, lr.Status, lr.AttachmentFile,
                e.FirstName, e.LastName,
                d.DeptName,
                lt.TypeName
            FROM leaverequests lr
            JOIN employees e ON lr.Emp_ID = e.Emp_ID
            JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID
            JOIN departments d ON e.Dept_ID = d.Dept_ID
            WHERE 1=1 
        `; 
        const params = []; 
        if (startDate) { sql += " AND lr.StartDate >= ?"; params.push(startDate); }
        if (endDate) { sql += " AND lr.EndDate <= ?"; params.push(endDate); }
        if (deptId) { sql += " AND e.Dept_ID = ?"; params.push(deptId); }
        if (leaveTypeId) { sql += " AND lr.LeaveType_ID = ?"; params.push(leaveTypeId); }
        if (status) { sql += " AND lr.Status = ?"; params.push(status); }
        sql += " ORDER BY lr.StartDate DESC";
        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (error) {
        console.error("Report API Error:", error);
        res.status(500).json({ message: 'Server Error: ' + error.message });
    }
});

// --- API 7: Quotas ---
app.get('/api/quotas/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const year = new Date().getFullYear(); 
        const [rows] = await pool.query(`
            SELECT 
                lb.RemainingDays,
                lt.TypeName
            FROM leavebalances lb
            JOIN leavetypes lt ON lb.LeaveType_ID = lt.LeaveType_ID
            WHERE lb.Emp_ID = ? AND lb.Year = ?
            ORDER BY lt.LeaveType_ID ASC
        `, [empId, year]);
        res.json(rows);
    } catch (error) {
           console.error("Quotas API Error:", error);
           res.status(500).json({ message: 'Server Error: ' + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});